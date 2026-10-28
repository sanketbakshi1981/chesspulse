'use strict';

const RENEW_MS = 30_000;
const TTL_SECONDS = 120;

function storageCredential({ endpoint, header, clientId, request = fetch, now = Date.now }) {
  if (!endpoint || !header || !clientId) throw new Error('Container Apps managed identity configuration is incomplete.');
  const url = new URL(endpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', 'https://storage.azure.com/');
  url.searchParams.set('client_id', clientId);
  let token;
  return {
    async getToken() {
      if (token && token.expiresOnTimestamp > now() + 60_000) return token;
      const response = await request(url, {
        headers: { 'X-IDENTITY-HEADER': header },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Managed identity token request failed: ${response.status}`);
      const data = await response.json();
      const expiry = Number(data.expires_on) * 1000;
      if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expiry) || expiry <= now()) {
        throw new Error('Managed identity endpoint returned an invalid token.');
      }
      token = { token: data.access_token, expiresOnTimestamp: expiry };
      return token;
    },
  };
}

class ActivityLease {
  constructor(queue, now = Date.now) {
    this.queue = queue;
    this.now = now;
    this.lastAttempt = -Infinity;
    this.message = null;
  }

  due() { return this.now() - this.lastAttempt >= RENEW_MS; }

  async update(active) {
    this.lastAttempt = this.now();
    const previous = this.message;
    if (active) {
      // TTL bounds stale activity after a crash; publish before removing the old lease.
      this.message = await this.queue.sendMessage('active', { messageTimeToLive: TTL_SECONDS });
    } else {
      this.message = null;
    }
    if (previous) await this.queue.deleteMessage(previous.messageId, previous.popReceipt);
  }
}

function activityLeaseFromEnvironment() {
  if (!process.env.ACTIVITY_QUEUE_URL) {
    if (process.env.CONTAINER_APP_NAME) throw new Error('ACTIVITY_QUEUE_URL is required in Container Apps.');
    return null;
  }
  if (!process.env.AZURE_CLIENT_ID) throw new Error('AZURE_CLIENT_ID is required for the activity queue.');
  const { QueueClient } = require('@azure/storage-queue');
  const credential = storageCredential({
    endpoint: process.env.IDENTITY_ENDPOINT,
    header: process.env.IDENTITY_HEADER,
    clientId: process.env.AZURE_CLIENT_ID,
  });
  return new ActivityLease(new QueueClient(process.env.ACTIVITY_QUEUE_URL, credential));
}

module.exports = { ActivityLease, activityLeaseFromEnvironment, storageCredential };
