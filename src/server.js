'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { Lobby } = require('./lobby');

const ROOT = path.join(__dirname, '..');

function createServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const lobby = new Lobby();

  app.use(express.static(path.join(ROOT, 'public')));
  // Browser builds of chess.js and the Stockfish WASM engine, served from npm packages.
  app.get('/vendor/chess.js', (req, res) => {
    res.sendFile(path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'));
  });
  app.use(
    '/vendor/stockfish',
    express.static(path.join(ROOT, 'node_modules/stockfish/bin'), {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      },
    }),
  );
  app.get('/healthz', (req, res) => res.json({ ok: true, online: lobby.players.size }));

  const broadcastPlayers = () => io.emit('players', lobby.listPlayers());

  const endGame = (game) => {
    io.to(game.id).emit('game:update', Lobby.gameState(game));
    for (const side of [game.white, game.black]) {
      io.sockets.sockets.get(side.id)?.leave(game.id);
    }
    lobby.removeGame(game.id);
    broadcastPlayers();
  };

  io.on('connection', (socket) => {
    const reply = (ack, payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    socket.on('join', (data, ack) => {
      const { player, error } = lobby.join(socket.id, data?.name);
      if (error) return reply(ack, { error });
      reply(ack, { id: player.id, name: player.name });
      broadcastPlayers();
    });

    socket.on('challenge', (data, ack) => {
      const previousTarget = lobby.cancelChallenge(socket.id);
      if (previousTarget) io.to(previousTarget).emit('challenge:cancelled', { from: socket.id });
      const result = lobby.challenge(socket.id, data?.to);
      if (result.error) return reply(ack, { error: result.error });
      io.to(result.to.id).emit('challenge:incoming', {
        from: { id: result.from.id, name: result.from.name },
      });
      reply(ack, { ok: true });
    });

    socket.on('challenge:cancel', () => {
      const toId = lobby.cancelChallenge(socket.id);
      if (toId) io.to(toId).emit('challenge:cancelled', { from: socket.id });
    });

    socket.on('challenge:respond', (data, ack) => {
      const result = lobby.respond(socket.id, data?.from, Boolean(data?.accept));
      if (result.error) return reply(ack, { error: result.error });
      reply(ack, { ok: true });
      if (result.declined) {
        io.to(result.challenger.id).emit('challenge:declined', {
          by: { id: result.target.id, name: result.target.name },
        });
        return;
      }
      const { game } = result;
      for (const side of [game.white, game.black]) {
        io.sockets.sockets.get(side.id)?.join(game.id);
      }
      io.to(game.id).emit('game:start', Lobby.gameState(game));
      broadcastPlayers();
    });

    socket.on('move', (data, ack) => {
      const result = lobby.move(socket.id, data?.gameId, data || {});
      if (result.error) return reply(ack, { error: result.error });
      reply(ack, { ok: true });
      if (result.game.result) endGame(result.game);
      else io.to(result.game.id).emit('game:update', Lobby.gameState(result.game));
    });

    socket.on('resign', (data, ack) => {
      const result = lobby.resign(socket.id, data?.gameId);
      if (result.error) return reply(ack, { error: result.error });
      reply(ack, { ok: true });
      endGame(result.game);
    });

    socket.on('disconnect', () => {
      const { player, game, cancelledTargets = [], cancelledChallengers = [] } = lobby.leave(socket.id);
      if (!player) return;
      for (const id of cancelledTargets) io.to(id).emit('challenge:cancelled', { from: socket.id });
      for (const id of cancelledChallengers) {
        io.to(id).emit('challenge:declined', { by: { id: player.id, name: player.name } });
      }
      if (game) endGame(game);
      else broadcastPlayers();
    });
  });

  return { app, httpServer, io, lobby };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { httpServer } = createServer();
  httpServer.listen(port, () => {
    console.log(`ChessPulse running at http://localhost:${port}`);
  });
}

module.exports = { createServer };
