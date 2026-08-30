import assert from 'node:assert/strict';
import test from 'node:test';
import { BunnyClient } from '../src/bunny-client.js';

test('index files purge their public trailing-slash cache keys exactly', async () => {
  const requests = [];
  const client = new BunnyClient({
    storageZoneName: 'zone',
    storageAccessKey: 'storage-key',
    storagePath: 'website',
    cdnHostname: 'cdn.example.test',
    apiAccessKey: 'api-key',
    fetch: async (url, init) => {
      requests.push([String(url), init]);
      return new Response('', { status: 200 });
    },
  });

  assert.equal(client.cdnUrl('index.html'), 'https://cdn.example.test/website/');
  assert.equal(client.cdnUrl('about/index.html'), 'https://cdn.example.test/website/about/');
  assert.equal(client.cdnUrl('assets/site.css'), 'https://cdn.example.test/website/assets/site.css');
  await client.purgeFile('about/index.html');
  const purge = new URL(requests[0][0]);
  assert.equal(purge.searchParams.get('url'), 'https://cdn.example.test/website/about/');
  assert.equal(purge.searchParams.get('exactPath'), 'true');
  assert.equal(purge.searchParams.get('async'), 'false');
});

test('ordinary files are explicitly sent as exact rather than prefix purges', async () => {
  const requests = [];
  const client = new BunnyClient({
    storageZoneName: 'zone',
    storageAccessKey: 'storage-key',
    cdnHostname: 'cdn.example.test',
    apiAccessKey: 'api-key',
    fetch: async url => {
      requests.push(String(url));
      return new Response('', { status: 200 });
    },
  });

  await client.purgeFile('img/resized/example-640.webp');
  const purge = new URL(requests[0]);
  assert.equal(purge.searchParams.get('exactPath'), 'true');
});

test('full cache purge targets the configured Pull Zone', async () => {
  const requests = [];
  const client = new BunnyClient({
    storageZoneName: 'zone',
    storageAccessKey: 'storage-key',
    apiAccessKey: 'api-key',
    pullZoneId: '12345',
    fetch: async (url, init) => {
      requests.push([String(url), init]);
      return new Response(null, { status: 204 });
    },
  });

  await client.purgePullZone();
  assert.equal(requests[0][0], 'https://api.bunny.net/pullzone/12345/purgeCache');
  assert.equal(requests[0][1].method, 'POST');
});

test('retry delay honors Bunny retry_after_seconds response bodies', async () => {
  const requests = [];
  const retryEvents = [];
  const client = new BunnyClient({
    storageZoneName: 'zone',
    storageAccessKey: 'storage-key',
    cdnHostname: 'cdn.example.test',
    apiAccessKey: 'api-key',
    retries: 1,
    onProgress: event => retryEvents.push(event),
    fetch: async (url, init) => {
      requests.push([String(url), init]);
      if (requests.length === 1) {
        return new Response(JSON.stringify({ retry_after_seconds: 0 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    },
  });

  await client.purgeFile('asset.css');
  assert.equal(requests.length, 2);
  assert.equal(retryEvents[0].delayMs, 0);
});
