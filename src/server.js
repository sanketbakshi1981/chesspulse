'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { Store, SESSION_MS } = require('./store');
const { Lobby } = require('./lobby');
const { CATALOG } = require('./quests');
const { activityLeaseFromEnvironment } = require('./activity');

const ROOT = path.join(__dirname, '..');
function sessionToken(cookie = '') {
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('cq_session='))?.slice(11) || '';
}

function createServer({ store = new Store(), lobbyOptions = {}, tickMs = 1000, activityLease = null } = {}) {
  const app = express();
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  const httpServer = http.createServer(app);
  const allowedOrigin = (origin, host) => !origin || origin === (process.env.APP_ORIGIN || `http://${host}`);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 8192,
    allowRequest: (req, callback) => callback(null, allowedOrigin(req.headers.origin, req.headers.host)),
  });
  const lobby = new Lobby(store, lobbyOptions);
  const limits = new Map();
  const rate = (key, max, window = 60_000) => {
    const now = Date.now();
    let value = limits.get(key);
    if (!value || value.expires <= now) { value = { count: 0, expires: now + window }; limits.set(key, value); }
    return ++value.count <= max;
  };
  const setCookie = (res, token, age = SESSION_MS) => res.setHeader('Set-Cookie',
    `cq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(age / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  const route = (fn) => (req, res, next) => store.exclusive(() => fn(req, res, next)).catch(next);
  const auth = async (req, res, next) => {
    try {
      const user = await store.session(sessionToken(req.headers.cookie));
      if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
      req.user = user;
      next();
    } catch (error) { next(error); }
  };
  const publicCatalog = CATALOG.map(({ validatorKey, ...definition }) => definition);
  const bootstrap = async (id) => {
    const activeId = await lobby.activeId(id);
    return {
      user: store.profile(await store.user(id)), catalog: publicCatalog,
      game: activeId ? lobby.snapshot(await lobby.game(activeId), id) : null,
      history: await lobby.history(id), queued: lobby.queue.has(id),
    };
  };
  const broadcastPlayers = async () => {
    io.emit('players', await lobby.listPlayers());
    const users = new Set([...io.sockets.sockets.values()].map((socket) => socket.data.userId));
    for (const id of users) {
      const incoming = [];
      for (const [from, to] of lobby.challenges) {
        if (to === id) incoming.push({ id: from, name: (await store.user(from)).name });
      }
      const target = lobby.challenges.get(id);
      io.to(`user:${id}`).emit('lobby:state', {
        incoming, outgoing: target ? (await store.user(target)).name : null, queued: lobby.queue.has(id),
      });
    }
  };
  const publish = async (game) => {
    for (const side of [game.white, game.black]) {
      io.to(`user:${side.id}`).emit('game:update', lobby.snapshot(game, side.id));
      if (game.result) io.to(`user:${side.id}`).emit('profile', await bootstrap(side.id));
    }
    await broadcastPlayers();
  };

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowedOrigin(req.get('origin'), req.get('host'))) return res.status(403).json({ error: 'Origin not allowed.' });
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON requests.' });
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  for (const action of ['register', 'login']) {
    app.post(`/api/auth/${action}`, route(async (req, res, next) => {
      if (!rate(`auth:${req.ip}`, 20)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid request.' });
      try {
        const user = await store[action](req.body);
        const token = await store.createSession(user.id);
        setCookie(res, token);
        res.json(await bootstrap(user.id));
      } catch (error) {
        if (error.code) return next(error);
        res.status(action === 'login' ? 401 : 400).json({ error: error.message });
      }
    }));
  }
  app.post('/api/auth/logout', auth, route(async (req, res) => {
    const token = sessionToken(req.headers.cookie);
    await store.logout(token);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.token === token) socket.disconnect(true);
    }
    setCookie(res, '', 0);
    res.json({ ok: true });
  }));
  app.get('/api/me', auth, route(async (req, res) => res.json(await bootstrap(req.user.id))));
  app.get('/api/games/:id', auth, route(async (req, res) => {
    const game = await lobby.game(req.params.id);
    if (!game || !lobby.colorOf(game, req.user.id)) return res.status(404).json({ error: 'Game not found.' });
    res.json(lobby.snapshot(game, req.user.id));
  }));
  app.post('/api/profile/visibility', auth, route(async (req, res) => {
    if (!rate(`profile:${req.user.id}`, 20)) return res.status(429).json({ error: 'Too many profile updates.' });
    if (typeof req.body?.visible !== 'boolean') return res.status(400).json({ error: 'Visibility must be true or false.' });
    await store.visibility(req.user.id, req.body.visible);
    await broadcastPlayers();
    res.json({ user: store.profile(await store.user(req.user.id)) });
  }));

  app.use('/vendor/stockfish', auth, route(async (req, res, next) => {
    if (await lobby.activeId(req.user.id)) return res.status(403).json({ error: 'Evaluation is prohibited during rated games.' });
    res.setHeader('Cache-Control', 'no-store');
    next();
  }), express.static(path.join(ROOT, 'node_modules/stockfish/bin'), {
    index: false, setHeaders(res, filename) {
      if (filename.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    },
  }));
  app.use('/vendor/jquery', express.static(path.join(ROOT, 'node_modules/jquery/dist'), { index: false }));
  app.use('/vendor/chessboard', express.static(path.join(ROOT, 'node_modules/@chrisoakman/chessboardjs/dist'), { index: false }));
  app.use('/vendor/chess', express.static(path.join(ROOT, 'node_modules/chess.js/dist/esm'), { index: false }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/healthz', route(async (req, res) => {
    await store.db.prepare('SELECT 1').get();
    res.json({ ok: true });
  }));

  io.use(async (socket, next) => {
    try {
      const token = sessionToken(socket.request.headers.cookie);
      const user = await store.session(token);
      if (!user) return next(new Error('Sign in to connect.'));
      socket.data.userId = user.id;
      socket.data.token = token;
      next();
    } catch (error) { next(error); }
  });
  io.on('connection', (socket) => {
    store.exclusive(async () => {
      const id = socket.data.userId;
      socket.join(`user:${id}`);
      lobby.connect(id, socket.id);
      const handle = (event, max, fn) => socket.on(event, (raw, ack) => {
        const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
        store.exclusive(async () => {
          if (!await store.session(socket.data.token)) { reply({ error: 'Session expired. Sign in again.' }); socket.disconnect(true); return; }
          if (!rate(`${id}:${event}`, max)) return reply({ error: 'Too many requests. Please slow down.' });
          if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) return reply({ error: 'Invalid request.' });
          lobby.connect(id, socket.id);
          reply(await fn(raw || {}));
          if (event.startsWith('challenge') || event.startsWith('matchmaking')) await broadcastPlayers();
        }).catch((error) => {
          console.error('Socket action failed:', event, error);
          reply({ error: 'Could not save your action. Please retry.' });
        });
      });
      handle('presence:heartbeat', 10, () => ({ ok: true }));
      handle('matchmaking:join', 20, async () => {
        const result = await lobby.enqueue(id);
        for (const game of await lobby.pair()) await publish(game);
        return result;
      });
      handle('matchmaking:leave', 20, () => { lobby.queue.delete(id); return { ok: true }; });
      handle('challenge', 20, async (data) => {
        const result = await lobby.challenge(id, data.name);
        if (result.to) io.to(`user:${result.to.id}`).emit('challenge:incoming', { from: { id, name: (await store.user(id)).name } });
        return result.error ? { error: result.error } : { ok: true };
      });
      handle('challenge:cancel', 20, () => {
        const to = lobby.challenges.get(id);
        lobby.challenges.delete(id);
        if (to) io.to(`user:${to}`).emit('challenge:cancelled', { from: id });
        return { ok: true };
      });
      handle('challenge:respond', 20, async (data) => {
        if (typeof data.accept !== 'boolean') return { error: 'Invalid challenge response.' };
        const result = await lobby.respond(id, data.from, data.accept);
        if (result.game) await publish(result.game);
        if (result.declined) io.to(`user:${data.from}`).emit('challenge:declined', { name: (await store.user(id)).name });
        return result.error ? { error: result.error } : { ok: true };
      });
      for (const action of ['move', 'guess', 'resign', 'offerDraw', 'respondDraw', 'claimDraw']) {
        handle(`game:${action}`, action === 'guess' ? 6 : action === 'move' ? 120 : 20, async (data) => {
          const result = await lobby.act(id, action, data);
          if (result.game) await publish(result.game);
          return result.error ? { error: result.error } : { ok: true };
        });
      }
      for (const [fromId, targetId] of lobby.challenges) {
        if (targetId === id) socket.emit('challenge:incoming', { from: { id: fromId, name: (await store.user(fromId)).name } });
      }
      await broadcastPlayers();
      socket.emit('session', await bootstrap(id));
    }).catch((error) => {
      console.error('Socket connection failed:', error);
      socket.disconnect(true);
    });
    socket.on('disconnect', () => {
      store.exclusive(async () => { lobby.disconnect(socket.id); await broadcastPlayers(); })
        .catch((error) => console.error('Socket disconnect failed:', error));
    });
  });
  let maintaining = false;
  const timer = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    store.exclusive(async () => {
      for (const game of await lobby.tick()) await publish(game);
      for (const game of await lobby.pair()) await publish(game);
      for (const [key, value] of limits) if (value.expires <= Date.now()) limits.delete(key);
      if (activityLease?.due()) {
        const active = io.sockets.sockets.size > 0
          || Boolean(await store.db.prepare('SELECT 1 FROM active_players LIMIT 1').get());
        await activityLease.update(active);
      }
      await broadcastPlayers();
    }).catch((error) => console.error('Game maintenance failed:', error))
      .finally(() => { maintaining = false; });
  }, tickMs);
  timer.unref();
  io.on('close', () => clearInterval(timer));
  httpServer.on('close', () => clearInterval(timer));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid or oversized JSON request.' });
    }
    console.error('Request failed:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  });
  return { app, httpServer, io, lobby, store };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Server startup failed:', error);
    process.exitCode = 1;
  });
}

async function start() {
  const port = Number(process.env.PORT) || 3000;
  const store = await Store.open();
  let server;
  try { server = createServer({ store, activityLease: activityLeaseFromEnvironment() }); }
  catch (error) { await store.close(); throw error; }
  const { httpServer, io } = server;
  httpServer.listen(port, () => console.log(`Chess Quest running at http://localhost:${port}`));
  const shutdown = () => io.close(async () => {
    try { await store.close(); }
    catch (error) { console.error('Database shutdown failed:', error); process.exitCode = 1; }
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createServer, sessionToken };
