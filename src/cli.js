import { BunnyClient } from './bunny-client.js';
import { configFromEnvironment } from './config.js';
import { createStatistics, readLocalManifest, synchronize } from './sync.js';
import { InteractiveProgress } from './progress.js';

export function parseArguments(argv) {
  const allowed = new Set(['--dry-run', '--check', '--interactive', '--help']);
  const unknown = argv.filter(argument => !allowed.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  return {
    dryRun: argv.includes('--dry-run') || argv.includes('--check'),
    interactive: argv.includes('--interactive'),
    help: argv.includes('--help'),
  };
}

export function formatStatistics(stats, { success, durationMs }) {
  const lines = [
    '',
    'Bunny synchronization summary',
    `  Outcome:                  ${success ? 'SUCCESS' : 'FAILED'}`,
    `  Local manifest files:     ${stats.localFiles}`,
    `  Remote manifest:          ${stats.remoteManifest}`,
    `  Remote manifest files:    ${stats.remoteFiles ?? 'unknown'}`,
    `  New files:                ${stats.added}`,
    `  Changed files (hash):     ${stats.changed}`,
    `  Unchanged files:          ${stats.unchanged}`,
    `  Files marked for deletion:${String(stats.deleted).padStart(2, ' ')}`,
    `  Uploads:                  ${stats.uploadsSucceeded} succeeded, ${stats.uploadsFailed} failed`,
    `  Deletions:                ${stats.deletesSucceeded} succeeded, ${stats.deletesMissing} already absent, ${stats.deletesFailed} failed`,
    `  CDN invalidation:         ${stats.purgeMode} for ${stats.purgeUrls} affected URL(s)`,
    `  CDN purge requests:       ${stats.purgesSucceeded} succeeded, ${stats.purgesSkipped} skipped, ${stats.purgesFailed} failed`,
    `  Pending purges recovered: ${stats.pendingPurgesRecovered}`,
    `  Remote purge log:         ${stats.purgeLog}`,
    `  Remote manifest uploaded: ${stats.manifestUploaded ? 'yes' : 'no'}`,
    `  Duration:                 ${(durationMs / 1000).toFixed(2)}s`,
  ];
  return lines.join('\n');
}

export async function runCli({ argv = process.argv.slice(2), environment = process.env, cwd = process.cwd() } = {}) {
  const started = Date.now();
  const stats = createStatistics();
  let success = false;
  let showSummary = true;
  let progress;
  try {
    const args = parseArguments(argv);
    if (args.help) {
      console.log('Usage: eleventy-bunny-sync [--interactive] [--dry-run|--check]');
      success = true;
      showSummary = false;
      return 0;
    }
    const config = configFromEnvironment(environment, cwd);
    progress = new InteractiveProgress({ enabled: args.interactive });
    progress.start();
    progress.handle({ type: 'stage', phase: 'Reading local manifest' });
    const localManifest = await readLocalManifest(config.localManifestPath);
    const client = new BunnyClient({ ...config.client, onProgress: event => progress.handle(event) });
    await synchronize({
      client,
      localManifest,
      dryRun: args.dryRun,
      concurrency: config.concurrency,
      purgeConcurrency: config.purgeConcurrency,
      fullPurgeThreshold: config.fullPurgeThreshold,
      projectDirectory: config.projectDirectory,
      statistics: stats,
      onWarning: warning => {
        const message = `Warning: ${warning}`;
        if (args.interactive) progress.handle({ type: 'message', message });
        else console.warn(message);
      },
      onProgress: event => progress.handle(event),
    });
    success = true;
    return 0;
  } catch (error) {
    console.error(`Bunny synchronization failed: ${error.message}`);
    if (error instanceof AggregateError) {
      for (const detail of error.errors) console.error(`  - ${detail?.message ?? detail}`);
    }
    return 1;
  } finally {
    progress?.stop();
    if (showSummary) console.log(formatStatistics(stats, { success, durationMs: Date.now() - started }));
  }
}
