import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiplayerClient } from '../export/web/multiplayer-client.js';
import { Frontend } from '../export/web/frontend.js';

test('missing room backend produces a setup error, not an offline label', async () => {
  const client = new MultiplayerClient();
  await assert.rejects(client.connect(''), /GitHub Pages only hosts the game/);
  assert.equal(client.status, 'error');
  assert.equal(client.active, false);
});

test('network failure explains the missing or unreachable backend', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('NetworkError'); });
  const client = new MultiplayerClient();
  await assert.rejects(client.connect('https://rooms.example'), /Cannot reach the room server/);
  assert.equal(client.status, 'error');
  assert.equal(client.active, false);
});

test('creating a chosen code sends that code and explains conflicts', async t => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response('Room exists', { status: 409 });
  });
  const client = new MultiplayerClient();
  await assert.rejects(client.connect('https://rooms.example', 'friends', true), /already in use/);
  assert.deepEqual(sent, { code: 'FRIENDS' });
  assert.equal(client.active, false);
});

test('join requires a code and invalid codes fail without making a room', async () => {
  const client = new MultiplayerClient();
  await assert.rejects(client.connect('https://rooms.example', '', false), /Enter the code/);
  await assert.rejects(client.connect('https://rooms.example', 'bad code!', true), /3–16/);
});

test('public HTTPS sites reject local and static-site backend URLs', async t => {
  const original = globalThis.location;
  globalThis.location = new URL('https://silver-lining-43.github.io/claude-of-duty-multiplayer/');
  t.after(() => { if (original === undefined) delete globalThis.location; else globalThis.location = original; });
  const client = new MultiplayerClient();
  await assert.rejects(client.connect('http://localhost:8787'), /HTTPS room server/);
  await assert.rejects(client.connect('https://localhost:8787'), /Localhost points to your own computer/);
  await assert.rejects(client.connect('https://silver-lining-43.github.io'), /static game website cannot run/);
  assert.equal(client.active, false);
});

test('leaving during room creation cannot reconnect when fetch resolves', async t => {
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const client = new MultiplayerClient();
  const connecting = client.connect('https://rooms.example');
  client.leave();
  finish(Response.json({ code: 'ABCDEF12' }));
  assert.equal(await connecting, false);
  assert.equal(client.status, 'offline');
  assert.equal(client.active, false);
  assert.equal(client.socket, null);
  assert.equal(client.code, null);
});

test('connection succeeds only after the room welcome, and leave clears identity', async t => {
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; Socket.latest = this; }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  const client = new MultiplayerClient();
  let complete = false;
  const connecting = client.connect('https://rooms.example', 'ABCDEF12').then(value => { complete = true; return value; });
  assert.equal(complete, false);
  Socket.latest.onmessage({ data: JSON.stringify({ type: 'welcome', id: 'player', peers: [] }) });
  assert.equal(await connecting, true);
  client.leave();
  assert.equal(client.status, 'offline');
  assert.equal(client.id, null);
  assert.equal(client.code, null);
  assert.equal(client.socket, null);
});

test('return to title keeps the game paused until explicitly played', () => {
  const frontend = new Frontend();
  frontend.setReady();
  frontend.enter();
  assert.equal(frontend.returnToTitle(), true);
  assert.equal(frontend.screen, 'title');
  assert.equal(frontend.visible, true);
});
