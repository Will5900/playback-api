//
// Debrid bridge — Real-Debrid for now, AllDebrid + Premiumize stubs.
// Token is supplied per-request from the device's debrid_tokens row.
//

import { request } from 'undici';

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

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
