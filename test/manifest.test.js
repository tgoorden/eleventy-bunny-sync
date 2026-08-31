import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectManifestSources,
  compareManifests,
  createLocalManifest,
  prepareManifestSynchronization,
  parseManifest,
  serialiseManifest,
} from '../src/manifest.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('manifest includes only Eleventy results and passthrough sources, never stale output files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bunny-manifest-'));
  const output = path.join(root, '_site');
  await mkdir(path.join(root, 'src', 'assets'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'index.html'), '<h1>Current</h1>');
  await writeFile(path.join(output, 'stale.html'), 'left over');
  await writeFile(path.join(root, 'src', 'assets', 'site.css'), 'body{}');

  const results = [{ outputPath: path.join(output, 'index.html') }];
  const passthroughMap = {
    '/assets/site.css': 'src/assets/site.css',
  };
  const sources = collectManifestSources({ results, passthroughMap, outputDirectory: output, projectDirectory: root });
  assert.deepEqual(sources.map(entry => [entry.path, path.relative(root, entry.source), entry.kind]), [
    ['assets/site.css', 'src/assets/site.css', 'passthrough'],
    ['index.html', '_site/index.html', 'template'],
  ]);

  const manifest = await createLocalManifest({ results, passthroughMap, outputDirectory: output, projectDirectory: root });
  assert.deepEqual(manifest.files.map(entry => entry[0]), ['assets/site.css', 'index.html']);
  assert.equal(manifest.files.some(entry => entry[0] === 'stale.html'), false);
});

test('comparison is linear by path and treats only a different hash as changed', () => {
  const local = {
    version: 1,
    hash: 'sha256',
    files: [
      ['added.txt', A, 1, 'src/added.txt'],
      ['same.txt', A, 999, 'src/same.txt'],
      ['updated.txt', B, 2, 'src/updated.txt'],
    ],
  };
  const remote = {
    version: 1,
    hash: 'sha256',
    files: [
      ['deleted.txt', A, 1],
      ['same.txt', A, 1],
      ['updated.txt', A, 2],
    ],
  };
  const result = compareManifests(local, remote);
  assert.deepEqual(result.added.map(entry => entry[0]), ['added.txt']);
  assert.deepEqual(result.changed.map(entry => entry[0]), ['updated.txt']);
  assert.deepEqual(result.unchanged.map(entry => entry[0]), ['same.txt']);
  assert.deepEqual(result.deleted.map(entry => entry[0]), ['deleted.txt']);
});

test('remote serialization strips local source paths and remains parseable', () => {
  const local = {
    version: 1,
    hash: 'sha256',
    preserve: ['img/**'],
    files: [['index.html', A, 12, '_site/index.html']],
  };
  const serialized = serialiseManifest(local, { remote: true });
  assert.equal(serialized.includes('_site'), false);
  assert.equal(serialized.includes('preserve'), false);
  assert.deepEqual(parseManifest(serialized).files, [['index.html', A, 12]]);
});

test('preserved output patterns exclude matching sources from the local manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bunny-manifest-preserve-'));
  const output = path.join(root, '_site');
  await mkdir(path.join(root, 'src', 'img', 'nested'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'index.html'), '<h1>Current</h1>');
  await writeFile(path.join(root, 'src', 'img', 'cover.jpg'), 'cover');
  await writeFile(path.join(root, 'src', 'img', 'nested', 'detail.jpg'), 'detail');

  const manifest = await createLocalManifest({
    results: [{ outputPath: path.join(output, 'index.html') }],
    passthroughMap: {
      '/img/cover.jpg': 'src/img/cover.jpg',
      '/img/nested/detail.jpg': 'src/img/nested/detail.jpg',
    },
    outputDirectory: output,
    projectDirectory: root,
    preserve: ['img/**'],
  });

  assert.deepEqual(manifest.preserve, ['img/**']);
  assert.deepEqual(manifest.files.map(entry => entry[0]), ['index.html']);
});

test('preparation carries preserved remote entries into the next complete manifest', () => {
  const local = {
    version: 1,
    hash: 'sha256',
    preserve: ['img/**'],
    files: [
      ['index.html', B, 2, '_site/index.html'],
      ['new.html', A, 1, '_site/new.html'],
    ],
  };
  const remote = {
    version: 1,
    hash: 'sha256',
    files: [
      ['img/cover.jpg', A, 100],
      ['img/nested/detail.jpg', B, 200],
      ['index.html', A, 1],
      ['old.html', A, 1],
    ],
  };

  const { difference, nextRemoteManifest } = prepareManifestSynchronization(local, remote);
  assert.deepEqual(difference.added.map(entry => entry[0]), ['new.html']);
  assert.deepEqual(difference.changed.map(entry => entry[0]), ['index.html']);
  assert.deepEqual(difference.deleted.map(entry => entry[0]), ['old.html']);
  assert.deepEqual(difference.preserved.map(entry => entry[0]), [
    'img/cover.jpg',
    'img/nested/detail.jpg',
  ]);
  assert.deepEqual(nextRemoteManifest.files, [
    ['img/cover.jpg', A, 100],
    ['img/nested/detail.jpg', B, 200],
    ['index.html', B, 2],
    ['new.html', A, 1],
  ]);
});

test('preparation rejects a local entry that overlaps a preserved path', () => {
  const local = {
    version: 1,
    hash: 'sha256',
    preserve: ['img/**'],
    files: [['img/cover.jpg', A, 1, 'src/img/cover.jpg']],
  };
  assert.throws(
    () => prepareManifestSynchronization(local, { version: 1, hash: 'sha256', files: [] }),
    /also matches a preserved path pattern/,
  );
});

test('preserved patterns must be positive normalized deployment paths', () => {
  const base = { version: 1, hash: 'sha256', files: [] };
  assert.throws(() => serialiseManifest({ ...base, preserve: ['!/img/**'] }), /invalid preserved/i);
  assert.throws(() => serialiseManifest({ ...base, preserve: ['/img/**'] }), /normalized/i);
  assert.throws(() => serialiseManifest({ ...base, preserve: ['img/**', 'img/**'] }), /unique/i);
});
