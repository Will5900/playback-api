//
// Debrid bridge — Real-Debrid for now, AllDebrid + Premiumize stubs.
// Token is supplied per-request from the device's debrid_tokens row.
//

import { request } from 'undici';

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';
const AD_BASE = 'https://api.alldebrid.com/v4';
const PM_BASE = 'https://www.premiumize.me/api';
const APP_NAME = 'Playback';

export interface ResolvedStream {
  directURL: string;
  filename?: string;
  sizeBytes?: number;
}

/** Convert a hoster link or magnet URL into a direct streamable URL. */
export async function rdResolve(token: string, link: string): Promise<ResolvedStream> {
  const body = new URLSearchParams({ link }).toString();
  const { statusCode, body: respBody } = await request(`${RD_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await respBody.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`RD unrestrict ${statusCode}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { download: string; filename: string; filesize: number };
  return { directURL: json.download, filename: json.filename, sizeBytes: json.filesize };
}

/** Cache check for a single magnet info hash. */
export async function rdInstantAvailability(token: string, infoHash: string): Promise<boolean> {
  const { statusCode, body } = await request(`${RD_BASE}/torrents/instantAvailability/${infoHash.toLowerCase()}`, {
    method: 'GET',
    headers: { 'authorization': `Bearer ${token}` },
  });
  if (statusCode < 200 || statusCode >= 300) return false;
  const text = await body.text();
  if (!text) return false;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const entry = json[infoHash.toLowerCase()];
    if (!entry || typeof entry !== 'object') return false;
    return Object.keys(entry as object).length > 0;
  } catch {
    return false;
  }
}

/** Add a magnet, select all video files, return torrent id. */
export async function rdAddMagnet(token: string, magnet: string): Promise<string> {
  const body = new URLSearchParams({ magnet }).toString();
  const { statusCode, body: rb } = await request(`${RD_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await rb.text();
  if (statusCode < 200 || statusCode >= 300) throw new Error(`RD addMagnet ${statusCode}: ${text}`);
  const json = JSON.parse(text) as { id: string };
  return json.id;
}

export async function rdSelectAllFiles(token: string, torrentId: string): Promise<void> {
  const body = new URLSearchParams({ files: 'all' }).toString();
  await request(`${RD_BASE}/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export async function rdTorrentInfo(token: string, torrentId: string): Promise<{ status: string; links: string[] }> {
  const { statusCode, body } = await request(`${RD_BASE}/torrents/info/${torrentId}`, {
    method: 'GET',
    headers: { 'authorization': `Bearer ${token}` },
  });
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) throw new Error(`RD info ${statusCode}: ${text}`);
  return JSON.parse(text);
}

export async function rdUserInfo(token: string): Promise<{ username: string; premium: number; expiration: string } | null> {
  const { statusCode, body } = await request(`${RD_BASE}/user`, {
    headers: { 'authorization': `Bearer ${token}` },
  });
  if (statusCode < 200 || statusCode >= 300) return null;
  return JSON.parse(await body.text());
}

// ─────────────────────────────────────────────────────────────────────────────
// AllDebrid
// https://docs.alldebrid.com/
// ─────────────────────────────────────────────────────────────────────────────

function adURL(path: string, apikey: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ agent: APP_NAME, apikey, ...extra });
  return `${AD_BASE}${path}?${params.toString()}`;
}

export async function adResolve(apikey: string, link: string): Promise<ResolvedStream> {
  const url = adURL('/link/unlock', apikey, { link });
  const { statusCode, body } = await request(url);
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`AD unlock ${statusCode}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { status: string; data?: { link: string; filename: string; filesize: number }; error?: { message: string } };
  if (json.status !== 'success' || !json.data) {
    throw new Error(`AD unlock failed: ${json.error?.message ?? 'unknown'}`);
  }
  return { directURL: json.data.link, filename: json.data.filename, sizeBytes: json.data.filesize };
}

export async function adInstantAvailability(apikey: string, infoHash: string): Promise<boolean> {
  const url = adURL('/magnet/instant', apikey, { 'magnets[]': infoHash });
  const { statusCode, body } = await request(url);
  if (statusCode < 200 || statusCode >= 300) return false;
  const json = JSON.parse(await body.text()) as {
    status: string;
    data?: { magnets?: Array<{ instant: boolean }> };
  };
  return json.status === 'success' && json.data?.magnets?.[0]?.instant === true;
}

export async function adUserInfo(apikey: string): Promise<{ username: string; isPremium: boolean } | null> {
  const url = adURL('/user', apikey);
  const { statusCode, body } = await request(url);
  if (statusCode < 200 || statusCode >= 300) return null;
  const json = JSON.parse(await body.text()) as {
    status: string;
    data?: { user: { username: string; isPremium: boolean } };
  };
  if (json.status !== 'success' || !json.data) return null;
  return { username: json.data.user.username, isPremium: json.data.user.isPremium };
}

// ─────────────────────────────────────────────────────────────────────────────
// Premiumize
// https://app.swaggerhub.com/apis-docs/premiumize.me/api
// ─────────────────────────────────────────────────────────────────────────────

function pmAuth(headers: Record<string, string>, apikey: string): Record<string, string> {
  return { ...headers, authorization: `Bearer ${apikey}` };
}

export async function pmResolve(apikey: string, link: string): Promise<ResolvedStream> {
  const body = new URLSearchParams({ src: link }).toString();
  const { statusCode, body: rb } = await request(`${PM_BASE}/transfer/directdl`, {
    method: 'POST',
    headers: pmAuth({ 'content-type': 'application/x-www-form-urlencoded' }, apikey),
    body,
  });
  const text = await rb.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`PM directdl ${statusCode}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    status: string;
    location?: string;
    filename?: string;
    filesize?: number;
    content?: Array<{ link: string; path: string; size: number; stream_link?: string }>;
    message?: string;
  };
  if (json.status !== 'success') {
    throw new Error(`PM directdl failed: ${json.message ?? 'unknown'}`);
  }
  if (json.location) {
    return { directURL: json.location, filename: json.filename, sizeBytes: json.filesize };
  }
  const file = (json.content ?? []).sort((a, b) => b.size - a.size)[0];
  if (!file) throw new Error('PM directdl: empty response');
  return { directURL: file.stream_link || file.link, filename: file.path, sizeBytes: file.size };
}

export async function pmInstantAvailability(apikey: string, infoHash: string): Promise<boolean> {
  const url = `${PM_BASE}/cache/check?items[]=${encodeURIComponent(infoHash)}`;
  const { statusCode, body } = await request(url, { headers: pmAuth({}, apikey) });
  if (statusCode < 200 || statusCode >= 300) return false;
  const json = JSON.parse(await body.text()) as { status: string; response?: boolean[] };
  return json.status === 'success' && json.response?.[0] === true;
}

export async function pmUserInfo(apikey: string): Promise<{ premium: boolean } | null> {
  const { statusCode, body } = await request(`${PM_BASE}/account/info`, { headers: pmAuth({}, apikey) });
  if (statusCode < 200 || statusCode >= 300) return null;
  const json = JSON.parse(await body.text()) as { status: string; premium_until?: number };
  return json.status === 'success' ? { premium: !!json.premium_until && json.premium_until * 1000 > Date.now() } : null;
}
