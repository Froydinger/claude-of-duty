import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { MultiplayerClient } from '../export/web/multiplayer-client.js';

test('interpolation crosses the yaw wrap using the short arc', () => {
  const client = new MultiplayerClient();
  const state = { position: [0, 0, 0], yaw: 3.1 };
  const peer = { samples: [{ ...state, time: 0 }, { ...state, position: [100, 20, 0], yaw: -3.1, time: 100 }] };
  const result = client.sample(peer, 150);
  assert.deepEqual(result.position, [50, 10, 0]);
  assert.ok(Math.abs(result.yaw - Math.PI) < 0.01);
});

test('two game browsers share movement, disconnect, and reconnect', { timeout: 240000 }, async t => {
  const out = 'artifacts/multiplayer';
  fs.mkdirSync(out, { recursive: true });
  const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'server/wrangler.jsonc', '--port', '8788'], { stdio: 'pipe' });
  let workerLog = '';
  worker.stdout.on('data', d => { workerLog += d; });
  worker.stderr.on('data', d => { workerLog += d; });
  t.after(() => { worker.kill(); fs.writeFileSync(`${out}/worker.log`, workerLog); });
  const root = path.resolve('export/web');
  const mime = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/plays')) { res.setHeader('Content-Type', 'application/json'); res.end('{"players":1,"plays":1}'); return; }
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(8000, '127.0.0.1', resolve));
  t.after(() => server.close());
  for (let i = 0; ; i++) {
    try { await fetch('http://127.0.0.1:8788/'); break; } catch (e) { if (i > 60) throw e; await new Promise(r => setTimeout(r, 500)); }
  }
  const executablePath = process.env.BROWSER_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1280, height: 720 } }), browser.newContext({ viewport: { width: 1280, height: 720 } })]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const errors = [];
  for (const page of pages) {
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => errors.push(r.url() + ': ' + r.failure()?.errorText));
  }
  const [a, b] = pages;
  await Promise.all(pages.map(p => p.goto('http://127.0.0.1:8000/?autostart=1')));
  await Promise.all(pages.map(p => p.waitForFunction(() => globalThis.hijacked?.debug?.getState().ready, null, { timeout: 120000 })));
  for (const page of pages) {
    await page.locator('#multiplayer-menu').evaluate(e => e.open = true);
    await page.locator('#mp-advanced').evaluate(e => e.open = true);
    await page.locator('#mp-server').fill('http://127.0.0.1:8788');
  }
  await a.locator('#mp-server').fill('');
  await a.locator('#mp-create').click();
  await a.waitForFunction(() => document.getElementById('mp-status').textContent.includes('GitHub Pages only hosts'));
  await a.screenshot({ path: out + '/missing-backend.png' });
  await a.locator('#mp-server').fill('http://127.0.0.1:8788');
  await a.locator('#mp-code').fill('Friends-' + Date.now().toString(36));
  const chosen = (await a.locator('#mp-code').inputValue()).toUpperCase();
  await a.locator('#mp-create').click();
  await a.waitForFunction(() => hijacked.debug.getState().multiplayer.status === 'connected');
  assert.equal(await a.locator('#mp-code').inputValue(), chosen);
  const code = await a.locator('#mp-code').inputValue();
  await b.locator('#mp-code').fill(code);
  const conflict = await fetch('http://127.0.0.1:8788/rooms', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(conflict.status, 409);
  await b.locator('#mp-join').click();
  await Promise.all(pages.map(p => p.waitForFunction(() => hijacked.debug.getState().multiplayer.peers.length === 1)));
  await a.locator('#mp-advanced').evaluate(e => e.open = false);
  await a.screenshot({ path: `${out}/room-menu.png` });
  const denied = new WebSocket('ws://127.0.0.1:8788/rooms/' + code + '?token=' + crypto.randomUUID());
  const deniedMessage = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Room capacity check timed out')), 10000);
    denied.addEventListener('message', event => { clearTimeout(timer); resolve(JSON.parse(event.data)); });
    denied.addEventListener('error', reject);
  });
  assert.equal(deniedMessage.type, 'error', 'third player is rejected');
  denied.close(4008);
  await Promise.all(pages.map(p => p.evaluate(() => hijacked.debug.setActive(true))));
  const before = await b.evaluate(() => hijacked.debug.getState().multiplayer.peers[0].position);
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(900);
  await a.keyboard.up('KeyW');
  await b.waitForFunction(before => {
    const p = hijacked.debug.getState().multiplayer.peers[0].position;
    return Math.hypot(...p.map((v, i) => v - before[i])) > 10;
  }, before);
  const previousYaw = await a.evaluate(() => hijacked.debug.getState().multiplayer.peers[0].yaw);
  await b.evaluate(() => { const p = hijacked.debug.getState().player.eye; hijacked.debug.lookAt([p[0] + 1000, p[1], p[2]]); });
  await a.waitForFunction(yaw => Math.abs(hijacked.debug.getState().multiplayer.peers[0].yaw - yaw) > 0.1, previousYaw);
  await b.keyboard.down('KeyC');
  await a.waitForFunction(() => hijacked.debug.getState().multiplayer.peers[0].crouch);
  await b.keyboard.up('KeyC');
  await b.keyboard.down('Space');
  await a.waitForFunction(() => !hijacked.debug.getState().multiplayer.peers[0].grounded);
  await b.keyboard.up('Space');
  await b.keyboard.down('ShiftLeft');
  await b.keyboard.down('KeyW');
  await a.waitForFunction(() => hijacked.debug.getState().multiplayer.peers[0].sprint && hijacked.debug.getState().multiplayer.peers[0].moving);
  await b.keyboard.up('KeyW');
  await b.keyboard.up('ShiftLeft');
  await b.evaluate(() => hijacked.debug.loadAllWeapons());
  await b.keyboard.press('Digit2');
  await a.waitForFunction(() => hijacked.debug.getState().multiplayer.peers[0].weapon === 'an94');
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${out}/player-${i + 1}.png` })));
  await a.evaluate(() => hijacked.debug.disconnectMultiplayer());
  await b.waitForFunction(() => hijacked.debug.getState().multiplayer.peers.length === 0, null, { timeout: 60000 });

  await Promise.all(pages.map(p => p.waitForFunction(() => hijacked.debug.getState().multiplayer.peers.length === 1, null, { timeout: 30000 })));
  for (const page of pages) assert.deepEqual(await page.evaluate(() => hijacked.debug.getState().multiplayer.bots), { active: 0, hitTargets: 0, attachedRoots: 0, agents: 0 });
  const states = await Promise.all(pages.map(p => p.evaluate(() => hijacked.debug.getState())));
  fs.writeFileSync(`${out}/state.json`, JSON.stringify(states, null, 2));
  fs.writeFileSync(`${out}/console.json`, JSON.stringify(errors, null, 2));
  assert.equal(states[0].multiplayer.code, states[1].multiplayer.code);
  await a.evaluate(() => hijacked.debug.showMenu(true));
  await a.locator('#mp-pause-leave').click();
  await a.waitForFunction(() => {
    const state = hijacked.debug.getState();
    return !state.multiplayer.active && state.multiplayer.status === 'offline' && state.multiplayer.code === null && state.menu.screen === 'title' && !state.active;
  });
  await b.waitForFunction(() => hijacked.debug.getState().multiplayer.peers.length === 0);
  await a.waitForTimeout(1800);
  assert.equal(await a.evaluate(() => hijacked.debug.getState().multiplayer.active), false);
  await a.screenshot({ path: out + '/left-room.png' });
  assert.deepEqual(await a.evaluate(() => hijacked.debug.getState().multiplayer.bots), { active: 6, hitTargets: 18, attachedRoots: 6, agents: 6 });
  await a.evaluate(() => hijacked.debug.setActive(true));
  await a.evaluate(() => hijacked.debug.showMenu(true));
  const feet = await a.evaluate(() => hijacked.debug.getState().player.feet);
  await a.locator('#mp-pause-leave').click();
  assert.equal(await a.evaluate(() => hijacked.debug.getState().menu.screen), 'title');
  assert.deepEqual(await a.evaluate(() => hijacked.debug.getState().player.feet), feet, 'returning from bot mode must not respawn');
  assert.deepEqual(errors, []);
});
