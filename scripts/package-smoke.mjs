import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result.stdout;
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'eleventy-bunny-sync-package-'));
try {
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', temporaryDirectory]);
  const [{ filename }] = JSON.parse(packOutput);
  const archive = path.join(temporaryDirectory, filename);
  const consumer = path.join(temporaryDirectory, 'consumer');
  await mkdir(consumer);

  run('npm', [
    'install',
    '--prefix', consumer,
    '--ignore-scripts',
    '--legacy-peer-deps',
    archive,
  ]);

  const installedPackage = path.join(consumer, 'node_modules/eleventy-bunny-sync');
  const executable = path.join(consumer, 'node_modules', '.bin', 'eleventy-bunny-sync');
  const help = run(executable, ['--help']);
  if (!help.includes('Usage: eleventy-bunny-sync')) {
    throw new Error('Installed package executable did not print its usage information.');
  }

  await import(path.join(installedPackage, 'src/index.js'));
  console.log(`Package smoke test passed for ${filename}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
