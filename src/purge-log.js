import { normaliseManifestPath } from './manifest.js';

const VALID_STATUSES = new Set(['pending', 'completed']);
const VALID_MODES = new Set(['none', 'targeted', 'full-zone']);

export function parsePurgeLog(text) {
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Remote purge log is not valid JSON: ${error.message}`, { cause: error });
  }
  if (value?.version !== 1 || !VALID_STATUSES.has(value.status) || !VALID_MODES.has(value.mode)) {
    throw new Error('Remote purge log has an unsupported format.');
  }
  if (!Array.isArray(value.paths)) throw new Error('Remote purge log paths must be an array.');
  const paths = [...new Set(value.paths.map(normaliseManifestPath))].sort();
  return { ...value, paths };
}

export function serialisePurgeLog({ status, mode, paths, error }) {
  const value = {
    version: 1,
    status,
    mode,
    paths: [...new Set(paths.map(normaliseManifestPath))].sort(),
    updatedAt: new Date().toISOString(),
  };
  if (error) value.error = String(error).slice(0, 1000);
  return `${JSON.stringify(value)}\n`;
}
