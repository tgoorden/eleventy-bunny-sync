import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  mapConcurrent,
  normaliseManifestPath,
  parseManifest,
  prepareManifestSynchronization,
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

function recordPurgeResults(stats, results) {
  stats.purgesSucceeded += results.filter(result => result.status === 'succeeded').length;
  stats.purgesSkipped += results.filter(result => result.status === 'skipped').length;
  stats.purgesFailed += results.filter(result => result.status === 'failed').length;
}

async function purgeExactPaths(client, pathNames, concurrency, onProgress) {
  return runOperations(pathNames.map(filePath => [filePath]), concurrency, async ([filePath]) => {
    const result = await client.purgeFile(filePath);
    return operationResult(filePath, result.skipped ? 'skipped' : 'succeeded');
  }, { kind: 'purge', onProgress });
}

export function createStatistics() {
  return {
    localFiles: 0,
    remoteFiles: null,
    remoteManifest: 'unknown',
    added: 0,
    changed: 0,
    unchanged: 0,
    preserved: 0,
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
    fullPurge = false,
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
  const { difference, nextRemoteManifest } = prepareManifestSynchronization(localManifest, remoteManifest);
  stats.added = difference.added.length;
  stats.changed = difference.changed.length;
  stats.unchanged = difference.unchanged.length;
  stats.preserved = difference.preserved.length;
  stats.deleted = difference.deleted.length;
  const uploads = [...difference.added, ...difference.changed];
  const hasChanges = remoteText === null || uploads.length > 0 || difference.deleted.length > 0;
  const hasPendingPurges = recoveredPaths.length > 0;
  if (dryRun) {
    onProgress({ type: 'stage', phase: 'Dry run complete' });
    return { stats, difference };
  }
  const supportsFullPurge = Boolean(client.apiAccessKey && client.pullZoneId)
    && typeof client.purgePullZone === 'function';
  if (fullPurge && !supportsFullPurge) {
    throw new Error('Full CDN purge requires BUNNY_API_KEY and BUNNY_PULL_ZONE_ID.');
  }
  if (!hasChanges && !hasPendingPurges) {
    stats.purgeMode = fullPurge ? 'full-zone' : 'targeted';
    stats.purgeUrls = 1;
    onProgress({ type: 'stage', phase: 'Recording no-change deployment attempt' });
    await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
      status: 'completed',
      mode: 'none',
      paths: [],
    }));
    stats.purgeLog = 'completed';
    onProgress({ type: 'stage', phase: 'Refreshing remote purge log CDN cache', total: 1 });
    const metadataPurgeResults = fullPurge
      ? await runOperations([['full Pull Zone']], 1, async () => {
        const result = await client.purgePullZone();
        return operationResult('full Pull Zone', result.skipped ? 'skipped' : 'succeeded');
      }, { kind: 'purge', onProgress })
      : await purgeExactPaths(client, [safePurgeLogRemotePath], 1, onProgress);
    recordPurgeResults(stats, metadataPurgeResults);
    const metadataPurgeFailures = metadataPurgeResults.filter(result => result.status === 'failed');
    if (metadataPurgeFailures.length) {
      const details = metadataPurgeFailures.map(result => result.error?.message ?? String(result.error)).join('; ');
      await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
        status: 'pending',
        mode: stats.purgeMode,
        paths: [safePurgeLogRemotePath],
        error: details,
      }));
      stats.purgeLog = 'pending';
      throw new AggregateError(
        metadataPurgeFailures.map(result => result.error),
        'Remote purge log CDN invalidation failed.',
      );
    }
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

  const affectedPathNames = [...new Set([
    ...recoveredPaths,
    ...uploads.map(entry => entry[0]),
    ...difference.deleted.map(entry => entry[0]),
  ])].sort();
  const purgePathNames = [...new Set([
    ...affectedPathNames,
    safePurgeLogRemotePath,
    ...(hasChanges ? [safeManifestRemotePath] : []),
  ])].sort();
  stats.purgeUrls = purgePathNames.length;
  const useFullPurge = supportsFullPurge
    && (fullPurge
      || remotePurgeLog?.status === 'pending' && remotePurgeLog.mode === 'full-zone'
      || affectedPathNames.length >= fullPurgeThreshold);
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
    await client.uploadManifest(safeManifestRemotePath, serialiseManifest(nextRemoteManifest, { remote: true }));
    stats.manifestUploaded = true;
  }

  if (useFullPurge) {
    onProgress({ type: 'stage', phase: 'Completing remote purge log' });
    await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
      status: 'completed',
      mode: stats.purgeMode,
      paths: purgePathNames,
    }));
    stats.purgeLog = 'completed';

    onProgress({
      type: 'stage',
      phase: `Invalidating entire Bunny CDN zone (${purgePathNames.length} affected URLs)`,
      total: 1,
    });
    const purgeResults = await runOperations([['full Pull Zone']], 1, async () => {
      const result = await client.purgePullZone();
      return operationResult('full Pull Zone', result.skipped ? 'skipped' : 'succeeded');
    }, { kind: 'purge', onProgress });
    recordPurgeResults(stats, purgeResults);
    const purgeFailures = purgeResults.filter(result => result.status === 'failed');
    if (purgeFailures.length) {
      const details = purgeFailures.map(result => result.error?.message ?? String(result.error)).join('; ');
      try {
        await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
          status: 'pending',
          mode: stats.purgeMode,
          paths: purgePathNames,
          error: details,
        }));
      } catch (logError) {
        throw new AggregateError(
          [...purgeFailures.map(result => result.error), logError],
          'Full CDN purge failed; updating the remote purge log also failed.',
        );
      }
      stats.purgeLog = 'pending';
      throw new AggregateError(
        purgeFailures.map(result => result.error),
        'Full CDN purge failed.',
      );
    }

    onProgress({ type: 'stage', phase: 'Synchronization complete' });
    return { stats, difference };
  }

  onProgress({
    type: 'stage',
    phase: 'Invalidating Bunny CDN',
    total: purgePathNames.length,
  });
  const purgeResults = await purgeExactPaths(client, purgePathNames, purgeConcurrency, onProgress);
  recordPurgeResults(stats, purgeResults);
  const purgeFailures = purgeResults.filter(result => result.status === 'failed');
  const finalLogStatus = purgeFailures.length ? 'pending' : 'completed';
  const finalLogPaths = purgeFailures.length
    ? purgeFailures.map(result => result.path)
    : purgePathNames;
  const details = purgeFailures.map(result => result.error?.message ?? String(result.error)).join('; ');

  onProgress({
    type: 'stage',
    phase: finalLogStatus === 'completed' ? 'Completing remote purge log' : 'Recording failed CDN invalidations',
  });
  try {
    await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
      status: finalLogStatus,
      mode: stats.purgeMode,
      paths: finalLogPaths,
      error: details,
    }));
  } catch (logError) {
    throw new AggregateError(
      [...purgeFailures.map(result => result.error), logError],
      `${purgeFailures.length} CDN purge operation(s) failed; updating the remote purge log also failed.`,
    );
  }
  stats.purgeLog = finalLogStatus;

  onProgress({ type: 'stage', phase: 'Refreshing remote purge log CDN cache', total: 1 });
  const finalLogPurgeResults = await purgeExactPaths(client, [safePurgeLogRemotePath], 1, onProgress);
  recordPurgeResults(stats, finalLogPurgeResults);
  const finalLogPurgeFailures = finalLogPurgeResults.filter(result => result.status === 'failed');
  const allPurgeFailures = [...purgeFailures, ...finalLogPurgeFailures];
  if (allPurgeFailures.length) {
    if (!purgeFailures.length) {
      const finalDetails = finalLogPurgeFailures
        .map(result => result.error?.message ?? String(result.error))
        .join('; ');
      await client.uploadPurgeLog(safePurgeLogRemotePath, serialisePurgeLog({
        status: 'pending',
        mode: 'targeted',
        paths: [safePurgeLogRemotePath],
        error: finalDetails,
      }));
      stats.purgeLog = 'pending';
    }
    throw new AggregateError(
      allPurgeFailures.map(result => result.error),
      `${allPurgeFailures.length} CDN purge operation(s) failed.`,
    );
  }

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
