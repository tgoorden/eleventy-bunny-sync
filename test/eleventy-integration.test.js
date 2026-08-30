import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Eleventy from '@11ty/eleventy';
import eleventyBunnyManifest from '../src/eleventy-plugin.js';

async function build(projectDirectory) {
  const previousDirectory = process.cwd();
  process.chdir(projectDirectory);
  try {
    const elev = new Eleventy('src', '_site', {
      configPath: false,
      quietMode: true,
      runMode: 'build',
      config(eleventyConfig) {
        eleventyConfig.addPlugin(eleventyBunnyManifest, { projectDirectory });
        eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' });
      },
    });
    await elev.write();
  } finally {
    process.chdir(previousDirectory);
  }
}

async function manifest(projectDirectory) {
  return JSON.parse(await readFile(path.join(projectDirectory, '.bunny-sync/manifest.json'), 'utf8'));
}

test('real Eleventy builds include results and passthrough sources but exclude stale output', async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'eleventy-bunny-sync-'));
  try {
    await mkdir(path.join(projectDirectory, 'src/assets'), { recursive: true });
    await mkdir(path.join(projectDirectory, '_site'), { recursive: true });
    await writeFile(path.join(projectDirectory, 'src/index.md'), '# Current page\n');
    await writeFile(path.join(projectDirectory, 'src/assets/current.txt'), 'current asset\n');
    await writeFile(path.join(projectDirectory, '_site/stale.txt'), 'left over from an old build\n');

    await build(projectDirectory);
    const firstPaths = (await manifest(projectDirectory)).files.map(entry => entry[0]);
    assert.deepEqual(firstPaths, ['assets/current.txt', 'index.html']);

    await unlink(path.join(projectDirectory, 'src/assets/current.txt'));
    await build(projectDirectory);
    const secondPaths = (await manifest(projectDirectory)).files.map(entry => entry[0]);
    assert.deepEqual(secondPaths, ['index.html']);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
