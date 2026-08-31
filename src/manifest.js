import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';

export const MANIFEST_VERSION = 1;
export const HASH_ALGORITHM = 'sha256';

function slash(value) {
  return value.split(path.sep).join('/');
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normaliseManifestPath(value) {
  const result = slash(String(value ?? '')).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!result || result.endsWith('/') || result.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid manifest path: ${JSON.stringify(value)}`);
  }
  return result;
}

export function normalisePreservePattern(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/');
  const result = raw.replace(/^\.\//, '').replace(/^\/+/, '');
  if (
    !result
    || result.startsWith('!')
    || result.endsWith('/')
    || result.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid preserved manifest path pattern: ${JSON.stringify(value)}`);
  }
  try {
    picomatch.makeRe(result, { dot: true, nonegate: true });
  } catch (error) {
    throw new Error(`Invalid preserved manifest path pattern ${JSON.stringify(value)}: ${error.message}`);
  }
  return result;
}

export function normalisePreservePatterns(value = []) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalisePreservePattern))].sort(comparePath);
}

export function createPreserveMatcher(patterns = []) {
  const normalised = normalisePreservePatterns(patterns);
  if (!normalised.length) return () => false;
  return picomatch(normalised, { dot: true, nonegate: true });
}

function outputRelativePath(outputDirectory, outputPath, projectDirectory) {
  const relative = path.relative(path.resolve(outputDirectory), path.resolve(projectDirectory, outputPath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Eleventy output is outside its output directory: ${outputPath}`);
  }
  return normaliseManifestPath(relative);
}

export async function hashFile(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`Manifest source is not a regular file: ${filePath}`);

  const hash = createHash(HASH_ALGORITHM);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { hash: hash.digest('hex'), size: fileStat.size };
}

export async function mapConcurrent(values, concurrency, mapper) {
  const items = Array.from(values);
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const count = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

export function collectManifestSources({ results, passthroughMap, outputDirectory, projectDirectory = process.cwd() }) {
  if (!Array.isArray(results)) throw new Error('Eleventy did not provide an output results array.');
  if (!passthroughMap || typeof passthroughMap !== 'object') {
    throw new Error('Eleventy did not emit its passthrough output-to-source map.');
  }

  const sources = new Map();
  const add = (remotePath, sourcePath, kind) => {
    const manifestPath = normaliseManifestPath(remotePath);
    const absoluteSource = path.resolve(projectDirectory, sourcePath);
    if (sources.has(manifestPath)) {
      throw new Error(`Multiple Eleventy outputs resolve to ${manifestPath}.`);
    }
    sources.set(manifestPath, { path: manifestPath, source: absoluteSource, kind });
  };

  for (const result of results) {
    if (!result?.outputPath) continue;
    add(outputRelativePath(outputDirectory, result.outputPath, projectDirectory), result.outputPath, 'template');
  }

  // Eleventy's event map uses URL-encoded output paths as keys and source paths as values.
  for (const [destinationUrl, sourcePath] of Object.entries(passthroughMap)) {
    add(normaliseManifestPath(decodeURI(destinationUrl)), sourcePath, 'passthrough');
  }

  return [...sources.values()].sort((a, b) => comparePath(a.path, b.path));
}

export async function createLocalManifest(options) {
  const {
    results,
    passthroughMap,
    outputDirectory,
    projectDirectory = process.cwd(),
    hashConcurrency = 8,
    preserve = [],
  } = options;
  const preservePatterns = normalisePreservePatterns(preserve);
  const isPreserved = createPreserveMatcher(preservePatterns);
  const sources = collectManifestSources({ results, passthroughMap, outputDirectory, projectDirectory })
    .filter(entry => !isPreserved(entry.path));
  const files = await mapConcurrent(sources, hashConcurrency, async entry => {
    const { hash, size } = await hashFile(entry.source);
    return [entry.path, hash, size, slash(path.relative(projectDirectory, entry.source)) || '.'];
  });
  return {
    version: MANIFEST_VERSION,
    hash: HASH_ALGORITHM,
    ...(preservePatterns.length ? { preserve: preservePatterns } : {}),
    files,
  };
}

export function toRemoteManifest(manifest) {
  const parsed = validateManifest(manifest, { requireSources: false });
  return {
    version: MANIFEST_VERSION,
    hash: HASH_ALGORITHM,
    files: parsed.files.map(([filePath, hash, size]) => [filePath, hash, size]),
  };
}

export function validateManifest(value, { requireSources = false } = {}) {
  if (!value || value.version !== MANIFEST_VERSION || value.hash !== HASH_ALGORITHM || !Array.isArray(value.files)) {
    throw new Error('Unsupported or malformed Bunny deployment manifest.');
  }

  if (value.preserve !== undefined) {
    if (!Array.isArray(value.preserve)) {
      throw new Error('Preserved manifest path patterns must be an array.');
    }
    const normalised = normalisePreservePatterns(value.preserve);
    if (normalised.length !== value.preserve.length
      || normalised.some((pattern, index) => pattern !== value.preserve[index])) {
      throw new Error('Preserved manifest path patterns must be unique, normalized, and sorted.');
    }
  }

  let previous = '';
  const seen = new Set();
  for (const entry of value.files) {
    if (!Array.isArray(entry) || entry.length < 3 || (requireSources && entry.length < 4)) {
      throw new Error('Malformed file entry in Bunny deployment manifest.');
    }
    const [rawPath, hash, size, source] = entry;
    const filePath = normaliseManifestPath(rawPath);
    if (filePath !== rawPath || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Malformed manifest entry for ${JSON.stringify(rawPath)}.`);
    }
    if (requireSources && (typeof source !== 'string' || !source)) {
      throw new Error(`Local source is missing for ${filePath}.`);
    }
    if (seen.has(filePath) || (previous && comparePath(previous, filePath) > 0)) {
      throw new Error('Manifest file entries must have unique, sorted paths.');
    }
    seen.add(filePath);
    previous = filePath;
  }
  return value;
}

export function serialiseManifest(manifest, { remote = false } = {}) {
  const value = remote ? toRemoteManifest(manifest) : validateManifest(manifest, { requireSources: true });
  return `${JSON.stringify(value)}\n`;
}

export async function writeManifest(filePath, manifest) {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, serialiseManifest(manifest), 'utf8');
  await rename(temporary, absolute);
}

export function parseManifest(text, options) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse Bunny deployment manifest: ${error.message}`);
  }
  return validateManifest(value, options);
}

export function compareManifests(localManifest, remoteManifest) {
  validateManifest(localManifest, { requireSources: true });
  validateManifest(remoteManifest);
  const remote = new Map(remoteManifest.files.map(entry => [entry[0], entry]));
  const added = [];
  const changed = [];
  const unchanged = [];

  for (const entry of localManifest.files) {
    const previous = remote.get(entry[0]);
    if (!previous) added.push(entry);
    else if (previous[1] !== entry[1]) changed.push(entry);
    else unchanged.push(entry);
    remote.delete(entry[0]);
  }

  return {
    added,
    changed,
    unchanged,
    deleted: [...remote.values()].sort((a, b) => comparePath(a[0], b[0])),
  };
}

export function prepareManifestSynchronization(localManifest, remoteManifest) {
  validateManifest(localManifest, { requireSources: true });
  validateManifest(remoteManifest);
  const isPreserved = createPreserveMatcher(localManifest.preserve ?? []);
  const overlapping = localManifest.files.find(entry => isPreserved(entry[0]));
  if (overlapping) {
    throw new Error(`Local manifest entry also matches a preserved path pattern: ${overlapping[0]}`);
  }

  const compared = compareManifests(localManifest, remoteManifest);
  const preserved = compared.deleted.filter(entry => isPreserved(entry[0]));
  const deleted = compared.deleted.filter(entry => !isPreserved(entry[0]));
  const nextRemoteManifest = toRemoteManifest(localManifest);
  nextRemoteManifest.files = [...nextRemoteManifest.files, ...preserved]
    .sort((a, b) => comparePath(a[0], b[0]));

  return {
    difference: { ...compared, deleted, preserved },
    nextRemoteManifest,
  };
}
