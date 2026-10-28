import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

const origin = new URL(process.argv[2]).origin;
const idleCheck = process.argv.includes('--idle-check');
if (idleCheck && (!process.env.AZURE_RESOURCE_GROUP || !process.env.AZURE_CONTAINER_APP_NAME)) {
  throw new Error('Idle verification requires AZURE_RESOURCE_GROUP and AZURE_CONTAINER_APP_NAME.');
}
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
  if (idleCheck) {
    console.log('Keeping a game active beyond the five-minute idle cooldown to verify connection survival.');
    for (let attempt = 0; attempt < 17; attempt++) {
      await sleep(20_000);
      assert.ok(white.connected && black.connected, 'An active game lost its replica or WebSocket.');
      await Promise.all([emit(a, 'presence:heartbeat'), emit(b, 'presence:heartbeat')]);
    }
    console.log('Active-game WebSockets survived the idle cooldown.');
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

  if (idleCheck) {
    console.log('Waiting for idle scale-to-zero using control-plane checks only (up to 12 minutes).');
    let zero = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      await sleep(30_000);
      const count = Number(execFileSync('az', [
        'containerapp', 'replica', 'list',
        '--resource-group', process.env.AZURE_RESOURCE_GROUP,
        '--name', process.env.AZURE_CONTAINER_APP_NAME,
        '--query', 'length(@)', '--output', 'tsv',
      ], { encoding: 'utf8' }).trim());
      assert.ok(Number.isInteger(count), 'Invalid replica-count response.');
      if (count === 0) { zero = true; break; }
    }
    assert.ok(zero, 'The app did not scale to zero within the verification window.');
    console.log('Zero replicas confirmed. Checking cold-start session and history persistence.');
    const resumed = await (await request('/api/me', { cookie: alice.cookie })).json();
    assert.equal(resumed.user.id, alice.user.id);
    assert.ok(resumed.history.some((entry) => entry.gameId === gameId));
    console.log('Cold-start wake-up and PostgreSQL persistence verified.');
  }
} finally {
  if (activeGame && participant?.connected) {
    try { await emit(participant, 'game:resign', { gameId: activeGame }); }
    catch (error) { console.error('Smoke-test game cleanup failed:', error.message); }
  }
  for (const socket of sockets) socket.close();
}
