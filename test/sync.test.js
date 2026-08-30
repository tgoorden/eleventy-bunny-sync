import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatistics, readLocalManifest, synchronize } from '../src/sync.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function local(files) {
  return { version: 1, hash: 'sha256', files };
}

function remote(files) {
  return `${JSON.stringify({ version: 1, hash: 'sha256', files })}\n`;
}

function withPurgeLog(client) {
  return {
    getPurgeLog: async () => null,
    uploadPurgeLog: async () => {},
    purgeFile: async () => ({ skipped: true }),
    ...client,
  };
}

test('missing local manifest directs the user to run the build first', async () => {
  await assert.rejects(
    readLocalManifest('/tmp/eleventy-bunny-sync-missing/manifest.json'),
    /build first/i,
  );
});

test('missing remote manifest automatically initializes a first deployment', async () => {
  const stats = createStatistics();
  let manifestUploaded = false;
  let manifestPath;
  const logPaths = [];
  const logs = [];
  const client = withPurgeLog({
    getManifest: async () => null,
    uploadManifest: async filePath => { manifestUploaded = true; manifestPath = filePath; },
    uploadPurgeLog: async (filePath, contents) => {
      logPaths.push(filePath);
      logs.push(JSON.parse(contents));
    },
  });
  await synchronize({ client, localManifest: local([]), statistics: stats });
  assert.equal(stats.localFiles, 0);
  assert.equal(stats.remoteManifest, 'missing');
  assert.equal(manifestUploaded, true);
  assert.equal(manifestPath, '.bunny-sync/manifest.json');
  assert.deepEqual(logPaths, ['.bunny-sync/purge-log.json', '.bunny-sync/purge-log.json']);
  assert.deepEqual(logs.map(log => log.status), ['pending', 'completed']);
});

test('first deployment uploads everything and advances the manifest before purging', async () => {
  const calls = [];
  const client = withPurgeLog({
    getManifest: async () => null,
    uploadPurgeLog: async (filePath, contents) => calls.push(`purge-log:${JSON.parse(contents).status}`),
    uploadFile: async filePath => calls.push(`upload:${filePath}`),
    deleteFile: async filePath => calls.push(`delete:${filePath}`),
    purgeFile: async filePath => (calls.push(`purge:${filePath}`), { skipped: false }),
    uploadManifest: async () => calls.push('manifest'),
  });
  const stats = createStatistics();
  await synchronize({
    client,
    localManifest: local([['index.html', A, 1, '_site/index.html']]),
    statistics: stats,
  });
  assert.deepEqual(calls, [
    'upload:index.html',
    'purge-log:pending',
    'manifest',
    'purge:.bunny-sync/manifest.json',
    'purge:.bunny-sync/purge-log.json',
    'purge:index.html',
    'purge-log:completed',
    'purge:.bunny-sync/purge-log.json',
  ]);
  assert.equal(stats.added, 1);
  assert.equal(stats.manifestUploaded, true);
});

test('already deleted remote files are warnings, not failures', async () => {
  const warnings = [];
  const client = withPurgeLog({
    getManifest: async () => remote([['old.txt', A, 1]]),
    deleteFile: async () => ({ missing: true }),
    purgeFile: async () => ({ skipped: true }),
    uploadManifest: async () => {},
  });
  const stats = createStatistics();
  await synchronize({
    client,
    localManifest: local([]),
    statistics: stats,
    onWarning: warning => warnings.push(warning),
  });
  assert.equal(stats.deletesMissing, 1);
  assert.equal(stats.manifestUploaded, true);
  assert.match(warnings[0], /old\.txt/);
});

test('operation failure prevents CDN purge and manifest advancement', async () => {
  let purged = false;
  let manifestUploaded = false;
  const client = withPurgeLog({
    getManifest: async () => remote([['index.html', A, 1]]),
    uploadFile: async () => { throw new Error('network down'); },
    purgeFile: async () => { purged = true; return { skipped: false }; },
    uploadManifest: async () => { manifestUploaded = true; },
  });
  const stats = createStatistics();
  await assert.rejects(synchronize({
    client,
    localManifest: local([['index.html', B, 1, '_site/index.html']]),
    statistics: stats,
  }), /storage operation/);
  assert.equal(purged, false);
  assert.equal(manifestUploaded, false);
  assert.equal(stats.uploadsFailed, 1);
});

test('unmanifested remote files are never considered or deleted', async () => {
  const deleted = [];
  const client = withPurgeLog({
    getManifest: async () => remote([['owned.txt', A, 1]]),
    deleteFile: async filePath => (deleted.push(filePath), { missing: false }),
    purgeFile: async () => ({ skipped: true }),
    uploadManifest: async () => {},
  });
  await synchronize({ client, localManifest: local([]) });
  assert.deepEqual(deleted, ['owned.txt']);
});

test('no hash changes performs no mutations and does not rewrite the manifest', async () => {
  let mutated = false;
  const purgeLogs = [];
  const purged = [];
  const client = withPurgeLog({
    getManifest: async () => remote([['index.html', A, 1]]),
    uploadFile: async () => { mutated = true; },
    deleteFile: async () => { mutated = true; },
    purgeFile: async filePath => (purged.push(filePath), { skipped: false }),
    uploadManifest: async () => { mutated = true; },
    uploadPurgeLog: async (filePath, contents) => purgeLogs.push(JSON.parse(contents)),
  });
  const stats = createStatistics();
  await synchronize({
    client,
    localManifest: local([['index.html', A, 99, '_site/index.html']]),
    statistics: stats,
  });
  assert.equal(mutated, false);
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.manifestUploaded, false);
  assert.equal(purgeLogs.length, 1);
  assert.equal(purgeLogs[0].status, 'completed');
  assert.equal(purgeLogs[0].mode, 'none');
  assert.deepEqual(purged, ['.bunny-sync/purge-log.json']);
  assert.equal(stats.purgesSucceeded, 1);
});

test('CDN purge failure preserves the advanced manifest and a pending purge log', async () => {
  let manifestUploaded = false;
  const purgeLogs = [];
  const client = withPurgeLog({
    getManifest: async () => remote([['index.html', A, 1]]),
    uploadFile: async () => {},
    purgeFile: async filePath => {
      if (filePath === 'index.html') throw new Error('purge failed');
      return { skipped: false };
    },
    uploadManifest: async () => { manifestUploaded = true; },
    uploadPurgeLog: async (filePath, contents) => purgeLogs.push(JSON.parse(contents)),
  });
  const stats = createStatistics();
  await assert.rejects(synchronize({
    client,
    localManifest: local([['index.html', B, 1, '_site/index.html']]),
    statistics: stats,
  }), /CDN purge/);
  assert.equal(stats.uploadsSucceeded, 1);
  assert.equal(stats.purgesFailed, 1);
  assert.equal(manifestUploaded, true);
  assert.equal(stats.manifestUploaded, true);
  assert.equal(purgeLogs.at(-1).status, 'pending');
  assert.deepEqual(purgeLogs.at(-1).paths, ['index.html']);
});

test('a later deploy retries pending purges even when both manifests match', async () => {
  const calls = [];
  const pendingLog = `${JSON.stringify({
    version: 1,
    status: 'pending',
    mode: 'targeted',
    paths: ['index.html'],
    updatedAt: '2026-08-30T00:00:00.000Z',
  })}\n`;
  const client = withPurgeLog({
    getManifest: async () => remote([['index.html', A, 1]]),
    getPurgeLog: async () => pendingLog,
    uploadFile: async () => calls.push('unexpected upload'),
    deleteFile: async () => calls.push('unexpected delete'),
    uploadManifest: async () => calls.push('unexpected manifest'),
    purgeFile: async filePath => (calls.push(`purge:${filePath}`), { skipped: false }),
    uploadPurgeLog: async (filePath, contents) => calls.push(`purge-log:${JSON.parse(contents).status}`),
  });
  const stats = createStatistics();

  await synchronize({
    client,
    localManifest: local([['index.html', A, 99, '_site/index.html']]),
    statistics: stats,
  });

  assert.deepEqual(calls, [
    'purge-log:pending',
    'purge:.bunny-sync/purge-log.json',
    'purge:index.html',
    'purge-log:completed',
    'purge:.bunny-sync/purge-log.json',
  ]);
  assert.equal(stats.pendingPurgesRecovered, 1);
  assert.equal(stats.manifestUploaded, false);
  assert.equal(stats.purgeLog, 'completed');
});

test('uploads use the configured parallel worker count', async () => {
  let active = 0;
  let maximumActive = 0;
  const files = Array.from({ length: 8 }, (_, index) => [
    `file-${index}.txt`, A, 1, `src/file-${index}.txt`,
  ]);
  const client = withPurgeLog({
    getManifest: async () => null,
    uploadFile: async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    },
    purgeFile: async () => ({ skipped: true }),
    uploadManifest: async () => {},
  });
  await synchronize({ client, localManifest: local(files), concurrency: 3 });
  assert.equal(maximumActive, 3);
});

test('many affected URLs use one full Pull Zone purge', async () => {
  const calls = [];
  const files = Array.from({ length: 3 }, (_, index) => [
    `file-${index}.txt`, A, 1, `src/file-${index}.txt`,
  ]);
  const client = withPurgeLog({
    apiAccessKey: 'api-key',
    pullZoneId: '12345',
    getManifest: async () => null,
    uploadFile: async () => {},
    purgeFile: async filePath => calls.push(`targeted:${filePath}`),
    purgePullZone: async () => (calls.push('full'), { skipped: false }),
    uploadManifest: async () => {},
  });
  const stats = createStatistics();

  await synchronize({
    client,
    localManifest: local(files),
    fullPurgeThreshold: 3,
    statistics: stats,
  });

  assert.deepEqual(calls, ['full', 'targeted:.bunny-sync/purge-log.json']);
  assert.equal(stats.purgeMode, 'full-zone');
  assert.equal(stats.purgeUrls, 5);
  assert.equal(stats.purgesSucceeded, 2);
});
