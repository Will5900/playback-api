//
// /me/rd-library — proxy Real-Debrid downloads enriched with TMDB posters.
// Single round-trip from iOS instead of N (one per item).
//

import { FastifyPluginAsync } from 'fastify';
import { request } from 'undici';
import { db } from '../db/pool.js';
import { env } from '../lib/env.js';
import { TTLCache } from '../lib/cache.js';

const cache = new TTLCache<unknown>(10 * 60 * 1000); // 10 min

interface RDDownload {
  id: string;
  filename: string;
  filesize: number;
  download: string;
  generated?: string;
}

const VIDEO_EXTS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv', 'flv', 'webm',
  'mpg', 'mpeg', 'ts', 'm2ts', 'vob', 'ogv', '3gp', 'rmvb',
]);

interface EnrichedRD {
  id: string;
  filename: string;
  niceName: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  overview?: string;
  filesize: number;
  download: string;
  generated?: string;
  ext: string;
  isMKV: boolean;
}

export const rdRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/rd-library', async (req, reply) => {
    const tok = await db.query<{ token: string }>(
      `SELECT token FROM debrid_tokens WHERE device_id = $1 AND provider = 'RD'`,
      [req.deviceId]
    );
    const token = tok.rows[0]?.token;
    if (!token) {
      reply.code(400);
      return { error: 'no Real-Debrid token configured' };
    }

    let downloads: RDDownload[];
    try {
      downloads = await fetchDownloads(token);
    } catch (e) {
      reply.code(502);
      return { error: 'Real-Debrid fetch failed', details: (e as Error).message };
    }

    const videoOnly = downloads.filter((d) => {
      const ext = d.filename.includes('.') ? d.filename.split('.').pop()!.toLowerCase() : '';
      return ext === '' || VIDEO_EXTS.has(ext);
    });

    const enriched = await Promise.all(
      videoOnly.map(async (d): Promise<EnrichedRD> => {
        const ext = d.filename.includes('.') ? d.filename.split('.').pop()!.toLowerCase() : '';
        const niceName = prettyName(d.filename);
        const year = extractYear(d.filename);
        const poster = await tmdbPoster(niceName, year);
        return {
          id: d.id,
          filename: d.filename,
          niceName,
          year,
          poster: poster?.poster,
          backdrop: poster?.backdrop,
          overview: poster?.overview,
          filesize: d.filesize,
          download: d.download,
          generated: d.generated,
          ext,
          isMKV: ext === 'mkv',
        };
      })
    );

    return { count: enriched.length, items: enriched };
  });
};

async function fetchDownloads(token: string): Promise<RDDownload[]> {
  const { statusCode, body } = await request('https://api.real-debrid.com/rest/1.0/downloads?limit=25', {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as RDDownload[];
}

function prettyName(raw: string): string {
  let s = raw;
  if (s.includes('.')) s = s.substring(0, s.lastIndexOf('.'));
  s = s.replace(/[._]/g, ' ');
  const cuts = ['1080p', '2160p', '720p', '480p', 'WEBRip', 'BluRay', 'WEB-DL',
                'x264', 'x265', 'HEVC', 'REMUX', 'HDR', 'DV', 'DDP5', 'DTS',
                'AAC', 'ATMOS', 'AMZN', 'NF', 'DSNP', 'HMAX'];
  const upper = s.toUpperCase();
  let cutAt = s.length;
  for (const c of cuts) {
    const i = upper.indexOf(c.toUpperCase());
    if (i !== -1 && i < cutAt) cutAt = i;
  }
  return s.substring(0, cutAt).trim() || raw;
}

function extractYear(raw: string): number | undefined {
  const m = raw.match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : undefined;
}

async function tmdbPoster(name: string, year?: number): Promise<{ poster?: string; backdrop?: string; overview?: string } | null> {
  if (!env.TMDB_API_KEY) return null;
  const key = `tmdb::${name}::${year ?? ''}`;
  const cached = cache.get(key) as { poster?: string; backdrop?: string; overview?: string } | undefined;
  if (cached !== undefined) return cached;

  const tries: Array<string> = [
    `https://api.themoviedb.org/3/search/movie?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&year=${year}` : ''}`,
    `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&first_air_date_year=${year}` : ''}`,
  ];

  for (const url of tries) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5_000);
    try {
      const { statusCode, body } = await request(url, { signal: ac.signal });
      if (statusCode < 200 || statusCode >= 300) continue;
      const json = await body.json() as { results?: Array<{ poster_path?: string; backdrop_path?: string; overview?: string }> };
      const hit = json.results?.[0];
      if (!hit) continue;
      const out = {
        poster:   hit.poster_path   ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : undefined,
        backdrop: hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : undefined,
        overview: hit.overview,
      };
      cache.set(key, out);
      return out;
    } catch { /* next */ }
    finally { clearTimeout(t); }
  }
  cache.set(key, null);
  return null;
}
