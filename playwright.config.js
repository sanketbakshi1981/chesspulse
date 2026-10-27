'use strict';

const { defineConfig } = require('@playwright/test');
const port = Number(process.env.E2E_PORT || 4317);
module.exports = defineConfig({
  testDir: './test/e2e',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: 'node test/e2e-server.js',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    env: { E2E_PORT: String(port) },
  },
});
