//
// Debrid bridge — Real-Debrid for now, AllDebrid + Premiumize stubs.
// Token is supplied per-request from the device's debrid_tokens row.
//

import { request } from 'undici';

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';
const RD_TIMEOUT_MS = 10_000;
const RD_MAX_ATTEMPTS = 3;

export interface ResolvedStream {
  directURL: string;
  filename?: string;
  sizeBytes?: number;
  mimeType?: string;
}

export interface RDUser {
  username: string;
  email?: string;
  premium: number;       // seconds remaining (RD field; 0 = free)
  expiration: string;    // ISO date
  type?: string;         // "premium" | "free"
}

export interface RDTorrentInfo {
  id: string;
  status: string;        // queued, downloading, downloaded, magnet_error, ...
  progress?: number;
  links: string[];
  files?: Array<{ id: number; path: string; bytes: number; selected: number }>;
}

class RDError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'RDError';
  }
}

interface CallOpts {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Don't retry — for endpoints whose effects are not idempotent. */
  noRetry?: boolean;
}

async function rdCall(token: string, path: string, opts: CallOpts = {}): Promise<{ statusCode: number; text: string }> {
  const url = `${RD_BASE}${path}`;
  const headers: Record<string, string> = {
    'authorization': `Bearer ${token}`,
    ...(opts.headers ?? {}),
  };
  if (opts.body && !headers['content-type']) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  const maxAttempts = opts.noRetry ? 1 : RD_MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), RD_TIMEOUT_MS);
    try {
      const { statusCode, body } = await request(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body,
        signal: ac.signal,
      });
      const text = await body.text();
      // Retry only transient server errors and rate-limits.
      if ((statusCode === 429 || (statusCode >= 500 && statusCode < 600)) && attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { statusCode, text };
    } catch (e) {
      lastErr = e;
      // AbortError or network blip — retry on early attempts.
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw new RDError(`RD request failed: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}

function backoffMs(attempt: number): number {
  // 200ms, 600ms, 1.4s — small jitter to spread bursts.
  return 200 * (3 ** (attempt - 1)) + Math.floor(Math.random() * 100);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function ensureOk(statusCode: number, text: string, what: string): void {
  if (statusCode < 200 || statusCode >= 300) {
    throw new RDError(`RD ${what} ${statusCode}: ${text.slice(0, 200)}`, statusCode);
  }
}

/** Convert a hoster link into a direct streamable URL. */
export async function rdResolve(token: string, link: string): Promise<ResolvedStream> {
  const { statusCode, text } = await rdCall(token, '/unrestrict/link', {
    method: 'POST',
    body: new URLSearchParams({ link }).toString(),
  });
  ensureOk(statusCode, text, 'unrestrict');
  const json = JSON.parse(text) as { download: string; filename?: string; filesize?: number; mimeType?: string };
  return {
    directURL: json.download,
    filename: json.filename,
    sizeBytes: json.filesize,
    mimeType: json.mimeType,
  };
}

/**
 * Cache check for a single magnet info hash.
 *
 * NOTE: Real-Debrid deprecated `/torrents/instantAvailability` in late 2024 and
 * the endpoint now returns empty objects unconditionally. We still call it so
 * we get the (rare) genuine hits, but the iOS UI should treat a missing
 * `_cached` flag as "unknown" rather than "not cached".
 */
export async function rdInstantAvailability(token: string, infoHash: string): Promise<boolean> {
  try {
    const { statusCode, text } = await rdCall(
      token,
      `/torrents/instantAvailability/${infoHash.toLowerCase()}`,
    );
    if (statusCode < 200 || statusCode >= 300) return false;
    if (!text) return false;
    const json = JSON.parse(text) as Record<string, unknown>;
    const entry = json[infoHash.toLowerCase()];
    if (!entry || typeof entry !== 'object') return false;
    return Object.keys(entry as object).length > 0;
  } catch {
    return false;
  }
}

/** Add a magnet URL, return the new torrent id. Idempotent on RD's side. */
export async function rdAddMagnet(token: string, magnet: string): Promise<string> {
  const { statusCode, text } = await rdCall(token, '/torrents/addMagnet', {
    method: 'POST',
    body: new URLSearchParams({ magnet }).toString(),
    noRetry: true,
  });
  ensureOk(statusCode, text, 'addMagnet');
  const json = JSON.parse(text) as { id: string };
  return json.id;
}

const VIDEO_EXT = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'm4v', 'webm', 'ts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg',
]);

const SAMPLE_RX = /\b(sample|trailer|extra|behindthescenes|featurette)\b/i;

function isVideoFile(path: string, bytes: number): boolean {
  const lower = path.toLowerCase();
  if (SAMPLE_RX.test(lower)) return false;
  // Skip obvious non-video clutter and tiny files (< 50 MB).
  if (bytes < 50 * 1024 * 1024) return false;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXT.has(lower.slice(dot + 1));
}

/**
 * Select files on a torrent. Waits briefly for RD to populate the file list
 * after addMagnet (status: waiting_files_selection), then selects only
 * video-ext files large enough to be the feature (no samples, no NFOs).
 * Falls back to "all" when no file looks like video so single-file torrents
 * with weird ext still play. Selection is required before RD will assemble
 * download links.
 */
export async function rdSelectVideoFiles(token: string, torrentId: string): Promise<void> {
  const info = await rdWaitForFiles(token, torrentId);
  const wanted = (info.files ?? []).filter((f) => isVideoFile(f.path, f.bytes));
  const ids = wanted.length > 0
    ? wanted.map((f) => f.id).join(',')
    : 'all';
  const { statusCode, text } = await rdCall(token, `/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    body: new URLSearchParams({ files: ids }).toString(),
    noRetry: true,
  });
  // 204 No Content is the success case here; treat 4xx as fatal.
  if (statusCode >= 400) {
    throw new RDError(`RD selectFiles ${statusCode}: ${text.slice(0, 200)}`, statusCode);
  }
}

/** Backwards-compat: old call site still works, but now skips clutter. */
export const rdSelectAllFiles = rdSelectVideoFiles;

/**
 * Poll torrent info until `files[]` is populated (RD has parsed the metadata).
 * Times out after `timeoutMs` and returns whatever the latest info is — the
 * caller can then fall back to selecting "all".
 */
export async function rdWaitForFiles(
  token: string,
  torrentId: string,
  timeoutMs = 5_000,
  intervalMs = 600,
): Promise<RDTorrentInfo> {
  const deadline = Date.now() + timeoutMs;
  let info = await rdTorrentInfo(token, torrentId);
  while ((!info.files || info.files.length === 0) && Date.now() < deadline) {
    if (info.status === 'magnet_error' || info.status === 'error' || info.status === 'virus' || info.status === 'dead') {
      return info;
    }
    await sleep(intervalMs);
    info = await rdTorrentInfo(token, torrentId);
  }
  return info;
}

export async function rdTorrentInfo(token: string, torrentId: string): Promise<RDTorrentInfo> {
  const { statusCode, text } = await rdCall(token, `/torrents/info/${torrentId}`);
  ensureOk(statusCode, text, 'info');
  return JSON.parse(text) as RDTorrentInfo;
}

/**
 * Wait up to `timeoutMs` for the torrent to reach `downloaded` status, polling
 * every `intervalMs`. Returns the final info regardless. Caller decides what
 * to do if status is still `downloading` / `queued`.
 */
export async function rdWaitForTorrent(
  token: string,
  torrentId: string,
  timeoutMs = 6_000,
  intervalMs = 1_000,
): Promise<RDTorrentInfo> {
  const deadline = Date.now() + timeoutMs;
  let info = await rdTorrentInfo(token, torrentId);
  while (info.status !== 'downloaded' && Date.now() < deadline) {
    if (info.status === 'magnet_error' || info.status === 'error' || info.status === 'virus' || info.status === 'dead') {
      return info;
    }
    await sleep(intervalMs);
    info = await rdTorrentInfo(token, torrentId);
  }
  return info;
}

/** Fetch the authenticated user. Returns null on auth failure (invalid token). */
export async function rdUserInfo(token: string): Promise<RDUser | null> {
  const { statusCode, text } = await rdCall(token, '/user', { noRetry: true });
  if (statusCode === 401 || statusCode === 403) return null;
  if (statusCode < 200 || statusCode >= 300) {
    throw new RDError(`RD /user ${statusCode}: ${text.slice(0, 200)}`, statusCode);
  }
  return JSON.parse(text) as RDUser;
}

/** Throws if the token is not accepted by RD. Used to validate on PUT. */
export async function rdValidateToken(token: string): Promise<RDUser> {
  const user = await rdUserInfo(token);
  if (!user) throw new RDError('Real-Debrid rejected the token', 401);
  return user;
}
