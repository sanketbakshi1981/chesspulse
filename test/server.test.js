'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');
const { Lobby } = require('../src/lobby');
const { testStore } = require('./helpers/store');

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}
function emit(socket, event, data = {}) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
}
async function fixture(t, options = {}) {
  const store = options.store || await testStore();
  const server = createServer({ store, ...options, lobbyOptions: { randomColor: () => true, ...options.lobbyOptions } });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.io.close(resolve));
    (await store.close());
  });
  async function account(name, rating = '1000') {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'testing-password', rating }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { ...data, cookie };
  }
  async function connect(account) {
    const socket = ioClient(base, { transports: ['websocket'], extraHeaders: { Cookie: account.cookie }, autoConnect: false });
    sockets.push(socket);
    const session = once(socket, 'session');
    socket.connect();
    await session;
    return socket;
  }
  return { ...server, base, account, connect };
}

test('authenticated end-to-end game, private quests, stale packets, recap and history', async (t) => {
  const f = await fixture(t);
  const alice = await f.account('Alice');
  const bob = await f.account('Bob');
  const a = await f.connect(alice);
  const b = await f.connect(bob);
  const incoming = once(b, 'challenge:incoming');
  assert.deepEqual(await emit(a, 'challenge', { name: 'Bob' }), { ok: true });
  const challenger = (await incoming).from;
  assert.equal(challenger.id, alice.user.id);
  assert.equal(challenger.name, 'Alice');
  const starts = Promise.all([once(a, 'game:update'), once(b, 'game:update')]);
  await emit(b, 'challenge:respond', { from: alice.user.id, accept: true });
  const [ga, gb] = await starts;
  assert.equal(ga.gameId, gb.gameId);
  assert.equal(ga.ownQuests.length, 1);
  assert.deepEqual(ga.revealedQuests, []);
  assert.equal(ga.assignments, undefined);
  assert.equal(ga.recap, null);
  assert.equal(ga.white.id, alice.user.id);
  assert.equal(ga.timeControl, '10+0');
  assert.match((await emit(b, 'game:move', { gameId: ga.gameId, version: 0, from: 'e7', to: 'e5' })).error, /turn/);
  const update = once(b, 'game:update');
  assert.deepEqual(await emit(a, 'game:move', { gameId: ga.gameId, version: 0, from: 'e2', to: 'e4' }), { ok: true });
  assert.deepEqual((await update).moves, ['e4']);
  assert.match((await emit(a, 'game:move', { gameId: ga.gameId, version: 0, from: 'e2', to: 'e4' })).error, /Stale/);
  assert.match((await emit(a, 'game:guess', { gameId: ga.gameId, questId: 'made-up' })).error, /Invalid/);
  const over = once(a, 'game:update');
  await emit(b, 'game:resign', { gameId: ga.gameId });
  const final = await over;
  assert.equal(final.result, '1-0');
  assert.equal(final.recap.players.w.ratingDelta, 16);
  assert.equal(final.recap.players.b.quests.length, 1);
  assert.equal(final.recap.players.w.total, 0);
  const me = await fetch(`${f.base}/api/me`, { headers: { Cookie: alice.cookie } }).then((r) => r.json());
  assert.equal(me.user.rating, 1016);
  assert.equal(me.history[0].gameId, ga.gameId);
  assert.equal(me.game, null);
  const recap = await fetch(`${f.base}/api/games/${ga.gameId}`, { headers: { Cookie: alice.cookie } }).then((r) => r.json());
  assert.deepEqual(recap.recap, final.recap);
});

test('disconnect/reconnect restores persistent identity, clock and private game; multiple tabs remain online', async (t) => {
  const f = await fixture(t);
  const alice = await f.account('Alice');
  const bob = await f.account('Bob');
  const a = await f.connect(alice);
  const a2 = await f.connect(alice);
  const b = await f.connect(bob);
  await emit(a, 'matchmaking:join');
  const start = once(a, 'game:update');
  await emit(b, 'matchmaking:join');
  const game = await start;
  a.close();
  assert.equal((await f.lobby.presence(alice.user.id)), 'in_game');
  assert.equal((await f.lobby.game(game.gameId)).result, null);
  a2.close();
  const recovered = await f.connect(alice);
  const response = await emit(recovered, 'game:move', { gameId: game.gameId, version: 0, from: 'e2', to: 'e4' });
  assert.deepEqual(response, { ok: true });
  const me = await fetch(`${f.base}/api/me`, { headers: { Cookie: alice.cookie } }).then((r) => r.json());
  assert.equal(me.user.id, alice.user.id);
  assert.deepEqual(me.game.moves, ['e4']);
  assert.ok(me.game.clocks.w <= 600_000);
});

test('authorization, origin checks, session logout and active engine gate are enforced', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/me`)).status, 401);
  const rejected = ioClient(f.base, { transports: ['websocket'], reconnection: false });
  t.after(() => rejected.close());
  assert.match((await once(rejected, 'connect_error')).message, /Sign in/);
  assert.equal((await fetch(`${f.base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: '{}',
  })).status, 403);
  const alice = await f.account('Alice');
  const bob = await f.account('Bob');
  const outsider = await f.account('Outsider');
  const a = await f.connect(alice);
  const b = await f.connect(bob);
  const c = await f.connect(outsider);
  await emit(a, 'matchmaking:join');
  const start = once(a, 'game:update');
  await emit(b, 'matchmaking:join');
  const game = await start;
  assert.equal((await fetch(`${f.base}/api/games/${game.gameId}`, { headers: { Cookie: outsider.cookie } })).status, 404);
  assert.match((await emit(c, 'game:guess', { gameId: game.gameId, questId: 'E01' })).error, /not playing/);
  assert.equal((await fetch(`${f.base}/vendor/stockfish/stockfish-19-lite-single.js`, { headers: { Cookie: alice.cookie } })).status, 403);
  const disconnected = once(a, 'disconnect');
  const logout = await fetch(`${f.base}/api/auth/logout`, { method: 'POST',
    headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  await disconnected;
  assert.equal((await fetch(`${f.base}/api/me`, { headers: { Cookie: alice.cookie } })).status, 401);
  assert.equal((await f.lobby.game(game.gameId)).result, null, 'logout leaves server clock running');
});

test('Codespaces development accepts only its exact forwarded origin for HTTP and sockets', async (t) => {
  const values = {
    CODESPACES: 'true', CODESPACE_NAME: 'questoc-origin-test',
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', NODE_ENV: 'development',
    APP_ORIGIN: undefined,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const f = await fixture(t);
  await f.account('ForwardedPlayer');
  const port = f.httpServer.address().port;
  const origin = `https://questoc-origin-test-${port}.app.github.dev`;
  const login = (Origin) => fetch(`${f.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin },
    body: JSON.stringify({ name: 'ForwardedPlayer', password: 'testing-password' }),
  });
  const response = await login(origin);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.name, 'ForwardedPlayer');
  assert.equal((await fetch(`${f.base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } })).status, 200);
  const otherOrigin = `https://another-codespace-${port}.app.github.dev`;
  assert.equal((await login(otherOrigin)).status, 403);
  assert.equal((await fetch(`${f.base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: otherOrigin } })).status, 403);
  process.env.APP_ORIGIN = 'https://configured.example';
  assert.equal((await login(origin)).status, 403);
  assert.equal((await login('https://configured.example')).status, 200);
  delete process.env.APP_ORIGIN;
  process.env.NODE_ENV = 'production';
  assert.equal((await login(origin)).status, 403);
});

test('configured alias redirects to the canonical origin without weakening origin checks', async (t) => {
  for (const [key, value] of Object.entries({
    APP_ORIGIN: 'https://questoc.com', APP_REDIRECT_HOST: 'www.questoc.com',
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const f = await fixture(t);
  const request = (requestPath, host, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(`${f.base}${requestPath}`, { method, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  for (const [method, requestPath] of [['GET', '/?invite=abc'], ['POST', '/api/auth/login']]) {
    const response = await request(requestPath, 'www.questoc.com', method);
    assert.equal(response.status, 308);
    assert.equal(response.headers.location, `https://questoc.com${requestPath}`);
  }
  const unusualPath = await request('//other.invalid/path', 'www.questoc.com');
  assert.equal(unusualPath.headers.location, 'https://questoc.com//other.invalid/path');
  for (const host of ['questoc.com', 'unrelated.invalid', 'www.questoc.com.other.invalid']) {
    const response = await request('/healthz', host);
    assert.equal(response.status, 200);
  }
  assert.equal((await fetch(`${f.base}/api/me`, {
    headers: { Host: 'questoc.com', Origin: 'https://questoc.com' },
  })).status, 401);
  assert.equal((await fetch(`${f.base}/api/me`, {
    headers: { Host: 'questoc.com', Origin: 'https://other.invalid' },
  })).status, 403);
  for (const origin of ['https://questoc.com', 'https://other.invalid']) {
    const response = await fetch(`${f.base}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: origin },
    });
    assert.equal(response.status, origin === 'https://questoc.com' ? 200 : 403);
  }
  for (const origin of ['', 'http://questoc.com', 'https://www.questoc.com', 'https://questoc.com/path']) {
    process.env.APP_ORIGIN = origin;
    assert.throws(() => createServer({ store: {} }), /requires a distinct HTTPS APP_ORIGIN/);
  }
});

test('registered player totals include offline accounts and do not count sessions or reconnects', async (t) => {
  const f = await fixture(t, { tickMs: 60_000 });
  assert.equal(await f.store.registeredPlayerCount(), 0);
  const alice = await f.account('CountAlice');
  assert.equal(alice.registeredPlayers, 1);
  const a = await f.connect(alice);
  const bob = await f.account('CountBob');
  assert.equal(bob.registeredPlayers, 2);
  await f.account('CountOffline');
  const update = once(a, 'lobby:state');
  const b = await f.connect(bob);
  assert.equal((await update).registeredPlayers, 3);
  const disconnected = once(a, 'lobby:state');
  b.close();
  assert.equal((await disconnected).registeredPlayers, 3);
  const reconnected = once(a, 'lobby:state');
  await f.connect(bob);
  assert.equal((await reconnected).registeredPlayers, 3);
  const me = await fetch(`${f.base}/api/me`, { headers: { Cookie: alice.cookie } }).then((res) => res.json());
  assert.equal(me.registeredPlayers, 3);
  const login = await fetch(`${f.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CountAlice', password: 'testing-password' }),
  });
  assert.equal((await login.json()).registeredPlayers, 3);
  const duplicate = await fetch(`${f.base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CountAlice', password: 'testing-password' }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal(await f.store.registeredPlayerCount(), 3);
});

test('directory automatically broadcasts connected players and removes offline accounts', async (t) => {
  const f = await fixture(t, { tickMs: 60_000 });
  const alice = await f.account('Alice');
  const bob = await f.account('Bob');
  await f.account('Offline');
  const a = await f.connect(alice);
  const joined = once(a, 'players');
  const b = await f.connect(bob);
  assert.deepEqual((await joined).map((u) => u.name), ['Alice', 'Bob']);
  const secondTabConnected = once(b, 'players');
  const a2 = await f.connect(alice);
  assert.equal((await secondTabConnected).length, 2);
  const secondTabClosed = once(b, 'players');
  a2.close();
  assert.deepEqual((await secondTabClosed).map((u) => u.name), ['Alice', 'Bob']);
  const retired = await fetch(`${f.base}/api/profile/visibility`, { method: 'POST',
    headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' }, body: '{"visible":false}' });
  assert.equal(retired.status, 410);
  assert.match((await retired.json()).error, /listed automatically/);
  assert.equal((await f.lobby.listPlayers()).length, 2);
  assert.deepEqual(await emit(a, 'presence:heartbeat'), { ok: true });
  const left = once(b, 'players');
  const logout = await fetch(`${f.base}/api/auth/logout`, { method: 'POST',
    headers: { Cookie: alice.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.deepEqual((await left).map((u) => u.name), ['Bob']);
});

test('serves chessboard.js visuals, all pieces and Stockfish 19 after authentication', async (t) => {
  const f = await fixture(t);
  const alice = await f.account('Alice');
  const html = await fetch(f.base).then((r) => r.text());
  assert.match(html, /<title>Questoc \| A Whole New Way to Play Chess\.<\/title>/);
  assert.ok(html.indexOf('/vendor/jquery/jquery.min.js') < html.indexOf('/vendor/chessboard/chessboard-1.0.0.min.js'));
  assert.ok(html.indexOf('/vendor/chessboard/chessboard-1.0.0.min.js') < html.indexOf('/app.mjs'));
  for (const asset of ['/vendor/jquery/jquery.min.js', '/vendor/chessboard/chessboard-1.0.0.min.js',
    '/vendor/chessboard/chessboard-1.0.0.min.css', '/vendor/chess/chess.js']) {
    assert.equal((await fetch(`${f.base}${asset}`)).status, 200, asset);
  }
  for (const color of ['w', 'b']) for (const piece of ['K', 'Q', 'R', 'B', 'N', 'P']) {
    const response = await fetch(`${f.base}/img/chesspieces/wikipedia/${color}${piece}.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/png/);
  }
  const headers = { Cookie: alice.cookie };
  assert.equal((await fetch(`${f.base}/vendor/stockfish/stockfish-19-lite-single.js`, { headers })).status, 200);
  const wasm = await fetch(`${f.base}/vendor/stockfish/stockfish-19-lite-single.wasm`, { method: 'HEAD', headers });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
});

test('profiles, games, rewards and session survive SQLite reopen', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'chessquest-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const filename = path.join(directory, 'test.sqlite');
  let store = new Store(filename);
  const alice = await store.register({ name: 'Alice', password: 'testing-password', rating: '1450' });
  const token = (await store.createSession(alice.id));
  const bob = await store.register({ name: 'Bob', password: 'testing-password', rating: '1450' });
  let lobby = new Lobby(store, { randomColor: () => true });
  lobby.connect(alice.id, 'a');
  lobby.connect(bob.id, 'b');
  const finished = (await lobby.start(alice.id, bob.id)).game;
  (await lobby.act(bob.id, 'resign', { gameId: finished.id }));
  const active = (await lobby.start(alice.id, bob.id)).game;
  (await lobby.act(alice.id, 'move', { gameId: active.id, version: 0, from: 'e2', to: 'e4' }));
  (await store.close());
  store = new Store(filename);
  lobby = new Lobby(store);
  assert.equal((await store.session(token)).id, alice.id);
  assert.equal(store.profile((await store.user(alice.id))).rating, 1466);
  assert.equal((await lobby.activeId(alice.id)), active.id);
  assert.deepEqual(lobby.snapshot((await lobby.game(active.id)), alice.id).moves, ['e4']);
  assert.equal(lobby.snapshot((await lobby.game(active.id)), alice.id).ownQuests.length, 1);
  assert.equal((await lobby.history(alice.id))[0].gameId, finished.id);
  assert.equal((await lobby.game(finished.id)).recap.players.w.ratingDelta, 16);
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM rating_changes').get()).n, 2);
  (await store.close());
});

test('concurrent queue requests create unique pairings and duplicate move packets serialize', async (t) => {
  const f = await fixture(t);
  const accounts = [];
  for (let i = 0; i < 10; i++) accounts.push(await f.account(`LoadPlayer${i}`));
  const sockets = await Promise.all(accounts.map((account) => f.connect(account)));
  const starts = sockets.map((socket) => once(socket, 'game:update'));
  await Promise.all(sockets.map((socket) => emit(socket, 'matchmaking:join')));
  const snapshots = await Promise.all(starts);
  assert.equal(new Set(snapshots.map((game) => game.gameId)).size, 5);
  assert.equal((await f.store.db.prepare('SELECT COUNT(*) AS n FROM active_players').get()).n, 10);
  const game = snapshots[0];
  const whiteIndex = accounts.findIndex((account) => account.user.id === game.white.id);
  const white = sockets[whiteIndex];
  const responses = await Promise.all([
    emit(white, 'game:move', { gameId: game.gameId, version: 0, from: 'e2', to: 'e4' }),
    emit(white, 'game:move', { gameId: game.gameId, version: 0, from: 'd2', to: 'd4' }),
  ]);
  assert.equal(responses.filter((r) => r.ok).length, 1);
  assert.equal((await f.lobby.game(game.gameId)).moves.length, 1);
  assert.match(responses.find((r) => r.error).error, /Stale/);
});

test('auth endpoints rate limit repeated attempts and reject non-JSON mutations', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/auth/login`, { method: 'POST', body: 'name=Alice' })).status, 415);
  let response;
  for (let i = 0; i < 21; i++) {
    response = await fetch(`${f.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing', password: 'wrong-password' }),
    });
  }
  assert.equal(response.status, 429);
});

test('health endpoint fails explicitly when the database query fails', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql === 'SELECT 1') throw new Error('injected health query failure');
    return prepare(sql);
  };
  const response = await fetch(`${f.base}/healthz`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Server error. Please try again.' });
});

test('maintenance finalizes disconnected games without an external activity signal', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { tickMs: 10, lobbyOptions: { now: () => now } });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await predicate(), 'Game maintenance did not converge.');
  };
  const alice = await f.account('Alice');
  const bob = await f.account('Bob');
  const a = await f.connect(alice);
  const b = await f.connect(bob);
  await emit(a, 'matchmaking:join');
  const start = once(a, 'game:update');
  await emit(b, 'matchmaking:join');
  const game = await start;
  a.close();
  b.close();
  await waitFor(() => f.io.sockets.sockets.size === 0);
  assert.equal((await f.lobby.game(game.gameId)).result, null);
  now += 600_001;
  await waitFor(async () => (await f.lobby.game(game.gameId)).result !== null);
  assert.equal((await f.lobby.game(game.gameId)).result, '0-1');
  assert.equal(await f.lobby.activeId(alice.user.id), undefined);
  assert.equal(await f.lobby.activeId(bob.user.id), undefined);
});
