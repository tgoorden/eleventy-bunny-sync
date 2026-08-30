import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  compareManifests,
  mapConcurrent,
  normaliseManifestPath,
  parseManifest,
  serialiseManifest,
  validateManifest,
} from './manifest.js';
import { parsePurgeLog, serialisePurgeLog } from './purge-log.js';
import { REMOTE_MANIFEST_PATH, REMOTE_PURGE_LOG_PATH } from './paths.js';

function operationResult(pathname, status, error) {
  return { path: pathname, status, error };
}

async function runOperations(items, concurrency, operation, { kind, onProgress }) {
  return mapConcurrent(items, concurrency, async item => {
    const pathname = item[0] ?? item;
    onProgress({ type: 'operation-start', kind, path: pathname });
    try {
      const result = await operation(item);
      onProgress({ type: 'operation-complete', kind, path: pathname, status: result.status });
      return result;
    } catch (error) {
      const result = operationResult(pathname, 'failed', error);
      onProgress({ type: 'operation-complete', kind, path: pathname, status: result.status });
      return result;
    }
  });
}

export function createStatistics() {
  return {
    localFiles: 0,
    remoteFiles: null,
    remoteManifest: 'unknown',
    added: 0,
    changed: 0,
    unchanged: 0,
    deleted: 0,
    uploadsSucceeded: 0,
    uploadsFailed: 0,
    deletesSucceeded: 0,
    deletesMissing: 0,
    deletesFailed: 0,
    purgesSucceeded: 0,
    purgesFailed: 0,
    purgesSkipped: 0,
    purgeMode: 'none',
    purgeUrls: 0,
    pendingPurgesRecovered: 0,
    purgeLog: 'unknown',
    manifestUploaded: false,
  };
}

export async function synchronize(options) {
  const {
    client,
    localManifest,
    dryRun = false,
    concurrency = 10,
    purgeConcurrency = concurrency,
    fullPurgeThreshold = 100,
    projectDirectory = process.cwd(),
    onWarning = () => {},
    onProgress = () => {},
  } = options;
  const stats = options.statistics ?? createStatistics();
  validateManifest(localManifest, { requireSources: true });
  stats.localFiles = localManifest.files.length;

  const safeManifestRemotePath = normaliseManifestPath(REMOTE_MANIFEST_PATH);
  const safePurgeLogRemotePath = normaliseManifestPath(REMOTE_PURGE_LOG_PATH);
  for (const metadataPath of [safeManifestRemotePath, safePurgeLogRemotePath]) {
    if (localManifest.files.some(entry => entry[0] === metadataPath)) {
      throw new Error(`A remote metadata path conflicts with website output: ${metadataPath}`);
    }
  }
  if (safeManifestRemotePath === safePurgeLogRemotePath) {
    throw new Error('The remote manifest and purge log paths must be different.');
  }

  onProgress({ type: 'stage', phase: 'Downloading remote manifest' });
  const remoteText = await client.getManifest(safeManifestRemotePath);
  let remoteManifest;
  if (remoteText === null) {
    stats.remoteManifest = 'missing';
    stats.remoteFiles = 0;
    remoteManifest = { version: 1, hash: 'sha256', files: [] };
  } else {
    stats.remoteManifest = 'found';
    remoteManifest = parseManifest(remoteText);
    stats.remoteFiles = remoteManifest.files.length;
  }

  onProgress({ type: 'stage', phase: 'Downloading remote purge log' });
  const purgeLogText = await client.getPurgeLog(safePurgeLogRemotePath);
  const remotePurgeLog = purgeLogText === null ? null : parsePurgeLog(purgeLogText);
  stats.purgeLog = remotePurgeLog?.status ?? 'missing';
  const recoveredPaths = remoteText !== null && remotePurgeLog?.status === 'pending'
    ? remotePurgeLog.paths
    : [];
  stats.pendingPurgesRecovered = recoveredPaths.length;

  onProgress({ type: 'stage', phase: 'Comparing manifests' });
  const difference = compareManifests(localManifest, remoteManifest);
  stats.added = difference.added.length;
  stats.changed = difference.changed.length;
  stats.unchanged = difference.unchanged.length;
  stats.deleted = difference.deleted.length;
  const uploads = [...difference.added, ...difference.changed];
  const hasChanges = remoteText === null || uploads.length > 0 || difference.deleted.length > 0;
  const hasPendingPurges = recoveredPaths.length > 0;
  if (dryRun) {
    onProgress({ type: 'stage', phase: 'Dry run complete' });
    return { stats, difference };
  }
  if (!hasChanges && !hasPendingPurges) {
    stats.purgeMode = 'none';
    stats.purgeUrls = 0;
    onProgress({ type: 'stage', phase: 'Recording no-change deployment attempt' });
    await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
      status: 'completed',
      mode: 'none',
      paths: [],
    }));
    stats.purgeLog = 'completed';
    onProgress({ type: 'stage', phase: 'Already synchronized' });
    return { stats, difference };
  }

  let uploadResults = [];
  let deleteResults = [];
  if (hasChanges) {
    onProgress({ type: 'stage', phase: 'Updating Bunny Storage', total: uploads.length + difference.deleted.length });
    [uploadResults, deleteResults] = await Promise.all([
      runOperations(uploads, concurrency, async entry => {
        const source = path.resolve(projectDirectory, entry[3]);
        await client.uploadFile(entry[0], source, entry[1]);
        return operationResult(entry[0], 'succeeded');
      }, { kind: 'upload', onProgress }),
      runOperations(difference.deleted, concurrency, async entry => {
        const result = await client.deleteFile(entry[0]);
        if (result.missing) {
          onWarning(`Remote file was already absent: ${entry[0]}`);
          return operationResult(entry[0], 'missing');
        }
        return operationResult(entry[0], 'succeeded');
      }, { kind: 'delete', onProgress }),
    ]);
  }
  stats.uploadsSucceeded = uploadResults.filter(result => result.status === 'succeeded').length;
  stats.uploadsFailed = uploadResults.filter(result => result.status === 'failed').length;
  stats.deletesSucceeded = deleteResults.filter(result => result.status === 'succeeded').length;
  stats.deletesMissing = deleteResults.filter(result => result.status === 'missing').length;
  stats.deletesFailed = deleteResults.filter(result => result.status === 'failed').length;

  const mutationFailures = [...uploadResults, ...deleteResults].filter(result => result.status === 'failed');
  if (mutationFailures.length) {
    throw new AggregateError(mutationFailures.map(result => result.error), `${mutationFailures.length} storage operation(s) failed.`);
  }

  const purgePathNames = [...new Set([
    ...recoveredPaths,
    ...uploads.map(entry => entry[0]),
    ...difference.deleted.map(entry => entry[0]),
  ])].sort();
  const purgePaths = purgePathNames.map(filePath => [filePath]);
  stats.purgeUrls = purgePaths.length;
  const useFullPurge = Boolean(client.apiAccessKey && client.pullZoneId)
    && typeof client.purgePullZone === 'function'
    && (remotePurgeLog?.status === 'pending' && remotePurgeLog.mode === 'full-zone'
      || purgePaths.length >= fullPurgeThreshold);
  stats.purgeMode = useFullPurge ? 'full-zone' : 'targeted';

  onProgress({ type: 'stage', phase: 'Recording pending CDN invalidations' });
  await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
    status: 'pending',
    mode: stats.purgeMode,
    paths: purgePathNames,
  }));
  stats.purgeLog = 'pending';

  if (hasChanges) {
    onProgress({ type: 'stage', phase: 'Uploading remote manifest' });
    await client.uploadManifest(safeManifestRemotePath, serialiseManifest(localManifest, { remote: true }));
    stats.manifestUploaded = true;
  }

  onProgress({
    type: 'stage',
    phase: useFullPurge ? `Invalidating entire Bunny CDN zone (${purgePaths.length} affected URLs)` : 'Invalidating Bunny CDN',
    total: useFullPurge ? 1 : purgePaths.length,
  });
  const purgeResults = useFullPurge
    ? await runOperations([['full Pull Zone']], 1, async () => {
      const result = await client.purgePullZone();
      return operationResult('full Pull Zone', result.skipped ? 'skipped' : 'succeeded');
    }, { kind: 'purge', onProgress })
    : await runOperations(purgePaths, purgeConcurrency, async ([filePath]) => {
      const result = await client.purgeFile(filePath);
      return operationResult(filePath, result.skipped ? 'skipped' : 'succeeded');
    }, { kind: 'purge', onProgress });
  stats.purgesSucceeded = purgeResults.filter(result => result.status === 'succeeded').length;
  stats.purgesSkipped = purgeResults.filter(result => result.status === 'skipped').length;
  stats.purgesFailed = purgeResults.filter(result => result.status === 'failed').length;
  const purgeFailures = purgeResults.filter(result => result.status === 'failed');
  if (purgeFailures.length) {
    const details = purgeFailures.map(result => result.error?.message ?? String(result.error)).join('; ');
    const pendingPaths = useFullPurge ? purgePathNames : purgeFailures.map(result => result.path);
    try {
      await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
        status: 'pending',
        mode: stats.purgeMode,
        paths: pendingPaths,
        error: details,
      }));
    } catch (logError) {
      throw new AggregateError(
        [...purgeFailures.map(result => result.error), logError],
        `${purgeFailures.length} CDN purge operation(s) failed; updating the pending purge log also failed.`,
      );
    }
    throw new AggregateError(purgeFailures.map(result => result.error), `${purgeFailures.length} CDN purge operation(s) failed.`);
  }

  onProgress({ type: 'stage', phase: 'Completing remote purge log' });
  await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
    status: 'completed',
    mode: stats.purgeMode,
    paths: purgePathNames,
  }));
  stats.purgeLog = 'completed';
  onProgress({ type: 'stage', phase: 'Synchronization complete' });
  return { stats, difference };
}

export async function readLocalManifest(filePath) {
  const text = await readFile(filePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Local manifest not found at ${filePath}. Run the Eleventy build first.`);
    throw error;
  });
  return parseManifest(text, { requireSources: true });
}
