import path from 'node:path';
import { normaliseRegion, normaliseStoragePath } from './bunny-client.js';
import { LOCAL_MANIFEST_PATH } from './paths.js';

function value(environment, name, fallback = '') {
  return String(environment[name] ?? fallback).trim();
}

function required(environment, name) {
  const result = value(environment, name);
  if (!result) throw new Error(`Missing required environment variable: ${name}`);
  return result;
}

function positiveInteger(environment, name, fallback) {
  const result = Number(value(environment, name, String(fallback)));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
  return result;
}

function pullZoneId(environment) {
  const result = value(environment, 'BUNNY_PULL_ZONE_ID');
  if (result && !/^[1-9]\d*$/.test(result)) throw new Error('BUNNY_PULL_ZONE_ID must be a positive integer.');
  return result;
}

export function configFromEnvironment(environment = process.env, projectDirectory = process.cwd()) {
  const cdnHostname = value(environment, 'BUNNY_CDN_HOSTNAME');
  const apiAccessKey = value(environment, 'BUNNY_API_KEY');
  if (Boolean(cdnHostname) !== Boolean(apiAccessKey)) {
    throw new Error('BUNNY_CDN_HOSTNAME and BUNNY_API_KEY must either both be set or both be omitted.');
  }

  return {
    projectDirectory: path.resolve(projectDirectory),
    localManifestPath: path.resolve(projectDirectory, LOCAL_MANIFEST_PATH),
    concurrency: positiveInteger(environment, 'BUNNY_MAX_CONCURRENT_OPERATIONS', 12),
    purgeConcurrency: positiveInteger(environment, 'BUNNY_MAX_CONCURRENT_PURGES', 8),
    fullPurgeThreshold: positiveInteger(environment, 'BUNNY_FULL_PURGE_THRESHOLD', 100),
    client: {
      storageZoneName: required(environment, 'BUNNY_STORAGE_ZONE_NAME'),
      storageAccessKey: required(environment, 'BUNNY_ACCESS_KEY'),
      storageRegion: normaliseRegion(value(environment, 'BUNNY_STORAGE_REGION')),
      storagePath: normaliseStoragePath(value(environment, 'BUNNY_STORAGE_PATH', '/')),
      cdnHostname,
      apiAccessKey,
      pullZoneId: pullZoneId(environment),
      retries: positiveInteger(environment, 'BUNNY_MAX_ATTEMPTS', 4) - 1,
      timeoutMs: positiveInteger(environment, 'BUNNY_REQUEST_TIMEOUT_MS', 120_000),
    },
  };
}
