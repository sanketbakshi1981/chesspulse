'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { Store } = require('../src/store');

const directory = mkdtempSync(path.join(tmpdir(), 'chessquest-e2e-'));
const store = new Store(path.join(directory, 'test.sqlite'));
// Medium currently has one enabled quest, making browser completion reproducible.
const { httpServer, io } = createServer({ store, lobbyOptions: { randomColor: () => true, questLevel: 'Medium', questCount: 1 } });
httpServer.listen(Number(process.env.E2E_PORT || 4317), '127.0.0.1');
const shutdown = () => io.close(() => {
  store.close();
  rmSync(directory, { recursive: true });
  process.exit(0);
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
