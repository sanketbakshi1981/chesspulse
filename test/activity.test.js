'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityLease, storageCredential } = require('../src/activity');

test('managed identity storage tokens use the local endpoint, cache and renew before expiry', async () => {
  let time = 0;
  let calls = 0;
  const credential = storageCredential({
    endpoint: 'http://localhost/identity',
    header: 'test-header',
    clientId: 'test-client',
    now: () => time,
    async request(url, options) {
      calls++;
      assert.equal(url.searchParams.get('client_id'), 'test-client');
      assert.equal(url.searchParams.get('resource'), 'https://storage.azure.com/');
      assert.equal(options.headers['X-IDENTITY-HEADER'], 'test-header');
      return { ok: true, async json() { return { access_token: `token-${calls}`, expires_on: (time + 120_000) / 1000 }; } };
    },
  });
  assert.equal((await credential.getToken()).token, 'token-1');
  time = 59_999;
  assert.equal((await credential.getToken()).token, 'token-1');
  time = 60_000;
  assert.equal((await credential.getToken()).token, 'token-2');
});

test('managed identity errors and malformed tokens are rejected explicitly', async () => {
  const config = { endpoint: 'http://localhost/identity', header: 'test', clientId: 'test', now: () => 0 };
  assert.throws(() => storageCredential({}), /configuration is incomplete/);
  await assert.rejects(storageCredential({
    ...config, request: async () => ({ ok: false, status: 403 }),
  }).getToken(), /failed: 403/);
  await assert.rejects(storageCredential({
    ...config, request: async () => ({ ok: true, json: async () => ({ access_token: 'test', expires_on: 'invalid' }) }),
  }).getToken(), /invalid token/);
});

test('activity is renewed before expiry and released when the application is idle', async () => {
  let time = 0;
  let counter = 0;
  const calls = [];
  const queue = {
    async sendMessage(text, options) {
      calls.push(['send', text, options.messageTimeToLive]);
      return { messageId: String(++counter), popReceipt: `receipt-${counter}` };
    },
    async deleteMessage(id, receipt) { calls.push(['delete', id, receipt]); },
  };
  const lease = new ActivityLease(queue, () => time);
  assert.equal(lease.due(), true);
  await lease.update(true);
  assert.equal(lease.due(), false);
  time = 29_999;
  assert.equal(lease.due(), false);
  time = 30_000;
  assert.equal(lease.due(), true);
  await lease.update(true);
  await lease.update(false);
  assert.deepEqual(calls, [
    ['send', 'active', 120],
    ['send', 'active', 120],
    ['delete', '1', 'receipt-1'],
    ['delete', '2', 'receipt-2'],
  ]);
});

test('queue write failures reject explicitly, preserve the previous lease and throttle retries', async () => {
  let time = 0;
  const marker = { messageId: 'old', popReceipt: 'receipt' };
  const lease = new ActivityLease({
    async sendMessage() { throw new Error('queue unavailable'); },
  }, () => time);
  lease.message = marker;
  await assert.rejects(lease.update(true), /queue unavailable/);
  assert.equal(lease.message, marker);
  assert.equal(lease.due(), false);
  time = 30_000;
  assert.equal(lease.due(), true);
});
