import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

const origin = new URL(process.argv[2]).origin;
if (process.argv.slice(3).some((arg) => arg !== '--connection-check')) {
  throw new Error('Usage: node infra/smoke-test.mjs <origin> [--connection-check]');
}
const connectionCheck = process.argv.includes('--connection-check');
const sockets = [];
const suffix = crypto.randomBytes(3).toString('hex');
let activeGame;
let participant;

async function request(path, { cookie, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}

async function account(label) {
  const response = await request('/api/auth/register', {
    body: { name: `AzureSmoke${label}${suffix}`, password: crypto.randomBytes(24).toString('hex') },
  });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  if (origin.startsWith('https:')) assert.match(header, /Secure/);
  return { ...(await response.json()), cookie: header.split(';')[0] };
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event}`)), 30_000);
    const success = (data) => finish(null, data);
    const failure = (error) => finish(error);
    function finish(error, data) {
      clearTimeout(timer);
      socket.off(event, success);
      socket.off('connect_error', failure);
      if (error) reject(error);
      else resolve(data);
    }
    socket.once(event, success);
    socket.once('connect_error', failure);
  });
}

function emit(socket, event, data = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(30_000).emit(event, data, (error, result) => {
      if (error) return reject(error);
      if (result.error) return reject(new Error(`${event}: ${result.error}`));
      resolve(result);
    });
  });
}

async function connect(account) {
  const socket = io(origin, {
    transports: ['websocket'], reconnection: false, autoConnect: false, forceNew: true,
    extraHeaders: { Cookie: account.cookie, Origin: origin },
  });
  sockets.push(socket);
  const session = once(socket, 'session');
  socket.connect();
  await session;
  return socket;
}

try {
  assert.deepEqual(await (await request('/healthz')).json(), { ok: true });
  const alice = await account('A');
  const bob = await account('B');
  const a = await connect(alice);
  const b = await connect(bob);
  await emit(a, 'matchmaking:join');
  const starts = Promise.all([once(a, 'game:update'), once(b, 'game:update')]);
  await emit(b, 'matchmaking:join');
  const [ga, gb] = await starts;
  activeGame = ga.gameId;
  participant = a;
  assert.equal(ga.gameId, gb.gameId);
  assert.equal(ga.timeControl, '10+0');
  assert.equal(ga.assignments, undefined);
  assert.equal(gb.assignments, undefined);
  assert.ok(ga.ownQuests.length > 0 && gb.ownQuests.length > 0);
  const white = ga.white.id === alice.user.id ? a : b;
  const black = white === a ? b : a;
  const blackState = black === a ? ga : gb;
  let update = once(white, 'game:update');
  await emit(white, 'game:move', { gameId: activeGame, version: 0, from: 'e2', to: 'e4' });
  let game = await update;
  update = once(white, 'game:update');
  await emit(black, 'game:move', { gameId: activeGame, version: game.version, from: 'e7', to: 'e5' });
  game = await update;
  assert.deepEqual(game.moves, ['e4', 'e5']);
  if (connectionCheck) {
    console.log('Keeping a game active for over five minutes to verify WebSocket connection survival.');
    for (let attempt = 0; attempt < 17; attempt++) {
      await sleep(20_000);
      assert.ok(white.connected && black.connected, 'An active game lost its WebSocket.');
      await Promise.all([emit(a, 'presence:heartbeat'), emit(b, 'presence:heartbeat')]);
    }
    console.log('Active-game WebSockets survived the connection check.');
  }
  update = once(white, 'game:update');
  await emit(white, 'game:guess', { gameId: activeGame, questId: blackState.ownQuests[0].questId });
  assert.equal((await update).guesses[0].correct, true);
  update = once(white, 'game:update');
  await emit(black, 'game:resign', { gameId: activeGame });
  const final = await update;
  assert.equal(final.result, '1-0');
  assert.equal(final.recap.players.w.ratingDelta, 16);
  assert.equal(final.recap.players.b.ratingDelta, -16);
  const gameId = activeGame;
  activeGame = null;
  for (const socket of sockets) socket.close();
  const me = await (await request('/api/me', { cookie: alice.cookie })).json();
  assert.equal(me.user.id, alice.user.id);
  assert.ok(me.history.some((entry) => entry.gameId === gameId));
  console.log('Live HTTPS, secure sessions, private quests, WebSockets, moves, guess, ratings and recap verified.');

} finally {
  if (activeGame && participant?.connected) {
    try { await emit(participant, 'game:resign', { gameId: activeGame }); }
    catch (error) { console.error('Smoke-test game cleanup failed:', error.message); }
  }
  for (const socket of sockets) socket.close();
}
