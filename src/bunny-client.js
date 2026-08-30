import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function encodePath(value) {
  return String(value).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function joinPath(...parts) {
  return parts.flatMap(part => String(part ?? '').split('/')).filter(Boolean).join('/');
}

async function responseError(response, operation) {
  const body = (await response.text().catch(() => '')).slice(0, 500).trim();
  return new Error(`${operation} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
}

async function retryDelay(response, attempt) {
  const rawHeader = response?.headers?.get('retry-after');
  const header = Number(rawHeader);
  if (rawHeader !== null && rawHeader !== undefined && Number.isFinite(header) && header >= 0) return header * 1000;
  if (response) {
    const body = await response.json().catch(() => null);
    const seconds = Number(body?.retry_after_seconds);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return Math.min(250 * (2 ** attempt), 4000) + Math.floor(Math.random() * 100);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class BunnyClient {
  constructor(options) {
    if (!options.storageZoneName || !options.storageAccessKey) {
      throw new Error('Bunny Storage zone name and access key are required.');
    }
    this.storageZoneName = options.storageZoneName;
    this.storageAccessKey = options.storageAccessKey;
    this.storageRegion = options.storageRegion || '';
    this.storagePath = options.storagePath || '';
    this.cdnHostname = options.cdnHostname || '';
    this.apiAccessKey = options.apiAccessKey || '';
    this.pullZoneId = options.pullZoneId || '';
    this.retries = options.retries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.onProgress = options.onProgress ?? (() => {});
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('A Fetch API implementation is required.');
  }

  storageUrl(relativePath) {
    const host = this.storageRegion ? `${this.storageRegion}.storage.bunnycdn.com` : 'storage.bunnycdn.com';
    const fullPath = joinPath(this.storageZoneName, this.storagePath, relativePath);
    return `https://${host}/${encodePath(fullPath)}`;
  }

  cdnUrl(relativePath) {
    if (!this.cdnHostname) throw new Error('Bunny CDN hostname is not configured.');
    const base = /^https?:\/\//i.test(this.cdnHostname) ? this.cdnHostname : `https://${this.cdnHostname}`;
    const url = new URL(base);
    let publicPath = joinPath(this.storagePath, relativePath);
    if (publicPath === 'index.html') publicPath = '';
    else if (publicPath.endsWith('/index.html')) publicPath = publicPath.slice(0, -'index.html'.length);
    url.pathname = `/${publicPath}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  async request(url, init, operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const requestInit = typeof init === 'function' ? init() : init;
        const response = await this.fetch(url, {
          ...requestInit,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!TRANSIENT_STATUS.has(response.status) || attempt === this.retries) return response;
        const retryResponse = response.clone();
        lastError = await responseError(response, operation);
        const delayMs = await retryDelay(retryResponse, attempt);
        this.onProgress({
          type: 'retry', operation, attempt: attempt + 2, attempts: this.retries + 1,
          delayMs, status: response.status,
        });
        await wait(delayMs);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries) throw new Error(`${operation} failed: ${error.message}`, { cause: error });
        const delayMs = await retryDelay(null, attempt);
        this.onProgress({
          type: 'retry', operation, attempt: attempt + 2, attempts: this.retries + 1,
          delayMs, error,
        });
        await wait(delayMs);
      }
    }
    throw lastError;
  }

  async getManifest(relativePath) {
    const response = await this.request(this.storageUrl(relativePath), {
      method: 'GET',
      headers: { AccessKey: this.storageAccessKey },
    }, 'Download remote manifest');
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response, 'Download remote manifest');
    return response.text();
  }

  async getPurgeLog(relativePath) {
    const response = await this.request(this.storageUrl(relativePath), {
      method: 'GET',
      headers: { AccessKey: this.storageAccessKey },
    }, 'Download remote purge log');
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response, 'Download remote purge log');
    return response.text();
  }

  async uploadFile(relativePath, sourcePath, expectedHash) {
    const fileStat = await stat(sourcePath);
    const response = await this.request(this.storageUrl(relativePath), () => ({
      method: 'PUT',
      headers: {
        AccessKey: this.storageAccessKey,
        Checksum: expectedHash.toUpperCase(),
        'Content-Length': String(fileStat.size),
      },
      body: createReadStream(sourcePath),
      duplex: 'half',
    }), `Upload ${relativePath}`);
    if (!response.ok) throw await responseError(response, `Upload ${relativePath}`);
  }

  async uploadManifest(relativePath, contents) {
    return this.uploadJson(relativePath, contents, 'Upload remote manifest');
  }

  async uploadPurgeLog(relativePath, contents) {
    return this.uploadJson(relativePath, contents, 'Upload remote purge log');
  }

  async uploadJson(relativePath, contents, operation) {
    const body = Buffer.from(contents, 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex').toUpperCase();
    const response = await this.request(this.storageUrl(relativePath), {
      method: 'PUT',
      headers: {
        AccessKey: this.storageAccessKey,
        Checksum: checksum,
        'Content-Length': String(body.length),
        'Content-Type': 'application/json',
      },
      body,
    }, operation);
    if (!response.ok) throw await responseError(response, operation);
  }

  async deleteFile(relativePath) {
    const response = await this.request(this.storageUrl(relativePath), {
      method: 'DELETE',
      headers: { AccessKey: this.storageAccessKey },
    }, `Delete ${relativePath}`);
    if (response.status === 404) return { missing: true };
    if (!response.ok) throw await responseError(response, `Delete ${relativePath}`);
    return { missing: false };
  }

  async purgeFile(relativePath) {
    if (!this.apiAccessKey || !this.cdnHostname) return { skipped: true };
    const purgeUrl = new URL('https://api.bunny.net/purge');
    const target = this.cdnUrl(relativePath);
    purgeUrl.searchParams.set('url', target);
    purgeUrl.searchParams.set('async', 'false');
    // Without this flag Bunny can classify ordinary file invalidations as the
    // much more restricted prefix-purge type.
    purgeUrl.searchParams.set('exactPath', 'true');
    const response = await this.request(purgeUrl, {
      method: 'POST',
      headers: { AccessKey: this.apiAccessKey },
    }, `Purge ${target}`);
    if (!response.ok) throw await responseError(response, `Purge ${target}`);
    return { skipped: false, url: target };
  }

  async purgePullZone() {
    if (!this.apiAccessKey || !this.pullZoneId) return { skipped: true };
    const url = `https://api.bunny.net/pullzone/${encodeURIComponent(this.pullZoneId)}/purgeCache`;
    const response = await this.request(url, {
      method: 'POST',
      headers: { AccessKey: this.apiAccessKey },
    }, `Purge Pull Zone ${this.pullZoneId}`);
    if (!response.ok) throw await responseError(response, `Purge Pull Zone ${this.pullZoneId}`);
    return { skipped: false };
  }
}

export function normaliseStoragePath(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('BUNNY_STORAGE_PATH contains an invalid segment.');
  return parts.join('/');
}

export function normaliseRegion(value) {
  const region = String(value ?? '').trim().toLowerCase();
  if (!region || region === 'de') return '';
  const allowed = new Set(['uk', 'ny', 'la', 'sg', 'se', 'br', 'jh', 'syd']);
  if (!allowed.has(region)) throw new Error(`Unsupported Bunny Storage region: ${region}`);
  return region;
}
