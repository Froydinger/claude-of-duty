import { DurableObject } from 'cloudflare:workers';

const TTL = 30 * 60 * 1000;
export function validState(s) {
  return s && Array.isArray(s.position) && s.position.length === 3 &&
    s.position.every(n => Number.isFinite(n) && Math.abs(n) < 100000) &&
    Number.isFinite(s.yaw) && Math.abs(s.yaw) < 1000 &&
    ['moving', 'sprint', 'crouch', 'grounded'].every(k => typeof s[k] === 'boolean') &&
    ['m27', 'an94', 'saritch', 'scar', 'sig556', 'tar21', 'type95', 'xm8', 'hk416'].includes(s.weapon);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
    if (origin && !allowed.includes(origin)) return new Response('Origin denied', { status: 403 });
    const headers = { 'Access-Control-Allow-Origin': origin ?? allowed[0],
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (url.pathname === '/rooms' && request.method === 'POST') {
      const body = await request.text();
      if (body.length > 128) return new Response('Request too large', { status: 413, headers });
      let requested = '';
      try { requested = String(body ? JSON.parse(body).code ?? '' : '').trim().toUpperCase(); }
      catch { return new Response('Invalid room request', { status: 400, headers }); }
      if (requested && !/^[A-Z0-9-]{3,16}$/.test(requested)) return new Response('Invalid room code', { status: 400, headers });
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = requested || crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
        const room = env.ROOMS.get(env.ROOMS.idFromName(code));
        const result = await room.fetch(new Request('https://room/init', { method: 'POST' }));
        if (result.ok) return Response.json({ code }, { headers });
        if (requested) return new Response('Room code already in use', { status: 409, headers });
      }
      return new Response('Could not allocate a room', { status: 503, headers });
    }
    const match = /^\/rooms\/([A-Z0-9-]{3,16})$/.exec(url.pathname);
    if (!match) return new Response('Not found', { status: 404, headers });
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
};

export class Room extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === '/init') {
      return this.ctx.blockConcurrencyWhile(async () => {
        if ((await this.ctx.storage.get('expires') ?? 0) > Date.now() || this.ctx.getWebSockets().length) return new Response('Room exists', { status: 409 });
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.put('expires', Date.now() + TTL);
        await this.ctx.storage.setAlarm(Date.now() + 30000);
        return new Response('ok');
      });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, socket] = Object.values(pair);
    this.ctx.acceptWebSocket(socket);
    const token = new URL(request.url).searchParams.get('token');
    const peers = this.ctx.getWebSockets().filter(s => s !== socket);
    const previous = peers.find(s => s.deserializeAttachment()?.token === token);
    const old = previous?.deserializeAttachment();
    const expires = await this.ctx.storage.get('expires');
    if (!expires || expires < Date.now() || !/^[a-f0-9-]{36}$/.test(token ?? '') || (peers.length >= 2 && !previous)) {
      socket.send(JSON.stringify({ v: 1, type: 'error', message: 'Room expired or full' }));
      socket.close(1008, 'Room expired or full');
    } else {
      previous?.close(1000, 'Reconnected');
      const id = old?.id ?? await this.ctx.storage.get('session:' + token) ?? crypto.randomUUID();
      await this.ctx.storage.put('session:' + token, id);
      socket.serializeAttachment({ id, token, seq: -1, last: Date.now(), state: old?.state });
      socket.send(JSON.stringify({ v: 1, type: 'welcome', id,
        peers: peers.filter(s => s !== previous).map(s => s.deserializeAttachment()).filter(Boolean).map(p => ({ id: p.id, state: p.state })) }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket, data) {
    const peer = socket.deserializeAttachment();
    if (!peer || typeof data !== 'string' || data.length > 2048) { socket.close(1008, 'Invalid packet'); return; }
    let m;
    try { m = JSON.parse(data); } catch { socket.close(1008, 'Invalid JSON'); return; }
    if (m.v !== 1 || m.type !== 'state' || !Number.isSafeInteger(m.seq) || !validState(m.state)) { socket.close(1008, 'Unsupported packet'); return; }
    if (m.seq <= peer.seq || Date.now() - (peer.sent ?? 0) < 25) return;
    Object.assign(peer, { seq: m.seq, state: m.state, last: Date.now(), sent: Date.now() });
    socket.serializeAttachment(peer);
    this.broadcast({ v: 1, type: 'state', id: peer.id, state: peer.state }, socket);
    await this.ctx.storage.put('expires', Date.now() + TTL);
  }
  broadcast(message, except) {
    for (const socket of this.ctx.getWebSockets()) if (socket !== except) {
      try { socket.send(JSON.stringify(message)); } catch { /* Close callback removes peer. */ }
    }
  }
  webSocketClose(socket, code) {
    const peer = socket.deserializeAttachment();
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code);
    if (peer && !this.ctx.getWebSockets().some(s => s !== socket && s.deserializeAttachment()?.id === peer.id)) this.broadcast({ v: 1, type: 'leave', id: peer.id }, socket);
  }
  webSocketError(socket) { socket.close(1011, 'Connection error'); }
  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      if (Date.now() - (socket.deserializeAttachment()?.last ?? 0) > 15000) socket.close(1000, 'Timed out');
    }
    if ((await this.ctx.storage.get('expires') ?? 0) < Date.now() && !this.ctx.getWebSockets().length) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(Date.now() + 30000);
  }
}
