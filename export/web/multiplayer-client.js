// Movement-only protocol v1. Combat messages are deliberately unsupported.
export class MultiplayerClient {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.peers = new Map();
    this.status = 'offline';
    this.sequence = 0;
  }
  async connect(endpoint, code = '', create = !code) {
    this.leave();
    const generation = this.generation;
    const controller = this.pending = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (!endpoint?.trim()) throw new Error('Online multiplayer needs a hosted room server. GitHub Pages only hosts the game files. Enter your deployed HTTPS room server URL.');
      let url;
      try { url = new URL(endpoint.trim()); } catch { throw new Error('Enter a valid HTTP(S) room server URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter the room server origin only, such as https://your-server.workers.dev.');
      const local = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
      if (globalThis.location?.protocol === 'https:' && url.protocol !== 'https:') throw new Error('This HTTPS game needs an HTTPS room server.');
      if (globalThis.location && !local(location.hostname) && local(url.hostname)) throw new Error('Localhost points to your own computer. Enter a hosted HTTPS room server URL for online play.');
      if (globalThis.location && url.origin === location.origin) throw new Error('The static game website cannot run multiplayer rooms. Enter the separate room server URL.');
      this.endpoint = url.origin;
      const requestedCode = String(code).trim().toUpperCase();
      if (requestedCode && !/^[A-Z0-9-]{3,16}$/.test(requestedCode)) throw new Error('Use 3–16 letters, numbers or hyphens for the room code.');
      if (!create && !requestedCode) throw new Error('Enter the code of the room you want to join.');
      code = requestedCode;
      this.setStatus(create ? 'creating room' : 'connecting');
      if (create) {
        let response;
        try { response = await fetch(this.endpoint + '/rooms', { method: 'POST', body: JSON.stringify({ code: requestedCode }), signal: controller.signal }); }
        catch { throw new Error('Cannot reach the room server. Check that it is running and allows this game website. GitHub Pages alone cannot host rooms.'); }
        if (response.status === 409) throw new Error('That room code is already in use. Join it or choose another code.');
        if (!response.ok) throw new Error('Room server returned HTTP ' + response.status + '. Check its URL and allowed website origins.');
        try { code = (await response.json()).code; } catch { throw new Error('This URL did not return a room. Enter the room backend URL, not the game website.'); }
      }
      if (generation !== this.generation) return false;
      this.code = String(code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,16}$/.test(this.code)) throw new Error('Room codes use 3–16 letters, numbers or hyphens.');
      if (create && requestedCode && this.code !== requestedCode) throw new Error('The room server needs the latest update to support chosen room codes.');
      this.active = true;
      this.token = crypto.randomUUID();
      await this.open(true);
      return generation === this.generation;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.leave();
      this.error = error.message;
      this.setStatus('error');
      throw error;
    } finally { clearTimeout(timeout); if (this.pending === controller) this.pending = null; }
  }
  open(initial = false) {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(this.endpoint.replace(/^http/, 'ws') + '/rooms/' + this.code + '?token=' + this.token);
      let welcomed = false;
      const timer = setTimeout(() => {
        if (welcomed || this.socket !== socket) return;
        socket.close(4000, 'Connection timed out');
        reject(new Error('The room server did not respond. Check its URL, deployment and allowed website origins.'));
      }, 10000);
      this.cancelOpen = () => { clearTimeout(timer); resolve(false); };
      this.setStatus(initial ? 'connecting' : 'reconnecting');
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return;
        let message;
        try { message = JSON.parse(data); } catch { socket.close(4008, 'Invalid server message'); return; }
        if (message.type === 'error') {
          clearTimeout(timer);
          reject(new Error(message.message));
          if (!initial) { this.leave(); this.error = message.message; this.setStatus('error'); }
          return;
        }
        if (message.type === 'welcome') {
          clearTimeout(timer);
          welcomed = true;
          this.cancelOpen = null;
          this.id = message.id;
          this.sequence = 0;
          this.peers.clear();
          for (const peer of message.peers) if (peer.state) this.receive(peer.id, peer.state);
          this.setStatus('connected');
          resolve(true);
        } else if (message.type === 'state') this.receive(message.id, message.state);
        else if (message.type === 'leave') this.peers.delete(message.id);
      };
      socket.onerror = () => {
        if (!welcomed) { clearTimeout(timer); reject(new Error('Cannot connect to the room server. Check that it is running and allows this game website.')); }
      };
      socket.onclose = ({ code }) => {
        clearTimeout(timer);
        if (this.socket !== socket || !this.active) return;
        this.peers.clear();
        if (initial && !welcomed) { reject(new Error('The room is unavailable or the server refused this website.')); return; }
        if (code === 1008 || code === 4008) { this.leave(); this.error = 'Room unavailable'; this.setStatus('error'); return; }
        this.setStatus('reconnecting');
        this.retry = setTimeout(() => { void this.open().catch(() => {}); }, 1500);
      };
    });
  }
  setStatus(status) { this.status = status; this.onStatus(this); }
  receive(id, state) {
    const peer = this.peers.get(id) ?? { samples: [] };
    peer.samples.push({ ...state, time: performance.now() });
    peer.samples = peer.samples.slice(-12);
    this.peers.set(id, peer);
  }
  send(state) {
    const now = performance.now();
    if (this.socket?.readyState !== WebSocket.OPEN || this.status !== 'connected' || now - (this.lastSend ?? 0) < 50) return;
    this.lastSend = now;
    this.socket.send(JSON.stringify({ v: 1, type: 'state', seq: ++this.sequence, state }));
  }
  sample(peer, now = performance.now()) {
    const time = now - 100;
    const samples = peer.samples;
    while (samples.length > 2 && samples[1].time <= time) samples.shift();
    const a = samples[0], b = samples[1] ?? a;
    const t = Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time || 1)));
    const angle = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    return { ...b, position: a.position.map((v, i) => v + (b.position[i] - v) * t), yaw: a.yaw + angle * t };
  }
  leave() {
    this.generation = (this.generation ?? 0) + 1;
    this.pending?.abort();
    this.pending = null;
    this.cancelOpen?.();
    this.cancelOpen = null;
    this.active = false;
    this.error = null;
    this.code = null;
    this.id = null;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Left room');
    this.peers.clear();
    this.setStatus('offline');
  }
  getState() {
    return { active: !!this.active, status: this.status, error: this.error, code: this.code, id: this.id,
      peers: [...this.peers].map(([id, peer]) => ({ id, ...this.sample(peer) })) };
  }
}
