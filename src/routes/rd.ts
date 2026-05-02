//
// /me/rd-library — proxy Real-Debrid downloads enriched with TMDB posters.
// Single round-trip from iOS instead of N (one per item).
//
// Three things keep this endpoint from causing the iOS "source error":
//   1. The whole enriched response is cached per (device, page, limit) for
//      a few minutes, so refreshes don't re-fan-out N TMDB lookups.
//   2. TMDB calls are concurrency-limited so we never burst past the free
//      tier's 40 req / 10s ceiling.
//   3. TMDB failure is non-fatal — items just come back without artwork.
//

import { FastifyPluginAsync } from 'fastify';
import { request } from 'undici';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { env } from '../lib/env.js';
import { TTLCache } from '../lib/cache.js';
import { normalizeArtworkSync } from '../lib/artwork.js';

// Per-call TMDB lookup cache.
const tmdbCache = new TTLCache<{ poster?: string; backdrop?: string; overview?: string } | null>(60 * 60 * 1000); // 1h

// Whole-response cache so repeated homepage loads don't re-do all the work.
const responseCache = new TTLCache<unknown>(3 * 60 * 1000); // 3 min

const RD_FETCH_TIMEOUT_MS = 7_000;
const TMDB_TIMEOUT_MS = 3_500;
const TMDB_CONCURRENCY = 4;

interface RDDownload {
  id: string;
  filename: string;
  filesize: number;
  download: string;
  generated?: string;
}

interface EnrichedRD {
  id: string;
  filename: string;
  niceName: string;
  year?: number;
  season?: number;
  episode?: number;
  isSeries: boolean;
  // All five fields point at the same URL — see lib/artwork.ts.
  posterURL?: string;
  backdropURL?: string;
  poster?: string;
  backdrop?: string;
  background?: string;
  overview?: string;
  filesize: number;
  download: string;
  generated?: string;
  ext: string;
  isMKV: boolean;
}

export const rdRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/rd-library', async (req, reply) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      page: z.coerce.number().int().min(1).default(1),
      // Bypass the response cache (for pull-to-refresh).
      fresh: z.coerce.boolean().optional(),
    }).parse(req.query);

    const tok = await db.query<{ token: string }>(
      `SELECT token FROM debrid_tokens WHERE device_id = $1 AND provider = 'RD'`,
      [req.deviceId]
    );
    const token = tok.rows[0]?.token;
    if (!token) {
      reply.code(400);
      return { error: 'no Real-Debrid token configured' };
    }

    const cacheKey = `rdlib::${req.deviceId}::${q.page}::${q.limit}`;
    if (!q.fresh) {
      const hit = responseCache.get(cacheKey);
      if (hit) return hit;
    }

    let downloads: RDDownload[];
    try {
      downloads = await fetchDownloads(token, q.limit, q.page);
    } catch (e) {
      reply.code(502);
      return { error: 'Real-Debrid fetch failed', details: (e as Error).message };
    }

    const enriched = await mapWithConcurrency(downloads, TMDB_CONCURRENCY, async (d): Promise<EnrichedRD> => {
      const ext = d.filename.includes('.') ? d.filename.split('.').pop()!.toLowerCase() : '';
      const parsed = parseFilename(d.filename);
      // TMDB failure is non-fatal — we still return the item.
      let tmdb: { poster?: string; backdrop?: string; overview?: string } | null = null;
      try {
        tmdb = await tmdbPoster(parsed.title, parsed.year, parsed.isSeries);
      } catch (e) {
        app.log.warn({ err: (e as Error).message, name: parsed.title }, 'tmdb lookup failed');
      }
      const art = normalizeArtworkSync({ poster: tmdb?.poster, backdrop: tmdb?.backdrop });
      return {
        id: d.id,
        filename: d.filename,
        niceName: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        isSeries: parsed.isSeries,
        ...art,
        overview: tmdb?.overview,
        filesize: d.filesize,
        download: d.download,
        generated: d.generated,
        ext,
        isMKV: ext === 'mkv',
      };
    });

    const out = { count: enriched.length, page: q.page, items: enriched };
    responseCache.set(cacheKey, out);
    return out;
  });
};

async function fetchDownloads(token: string, limit: number, page: number): Promise<RDDownload[]> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RD_FETCH_TIMEOUT_MS);
  try {
    const url = `https://api.real-debrid.com/rest/1.0/downloads?limit=${limit}&page=${page}`;
    const { statusCode, body } = await request(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const text = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP ${statusCode}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as RDDownload[];
  } finally {
    clearTimeout(t);
  }
}

interface ParsedName {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  isSeries: boolean;
}

const RELEASE_CUTS = [
  '1080p', '2160p', '4k', '720p', '480p',
  'webrip', 'web-rl', 'web-dl', 'webdl', 'bluray', 'brrip', 'bdrip', 'hdrip', 'hdtv', 'dvdrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'remux',
  'hdr', 'hdr10', 'dv', 'dovi',
  'ddp5', 'dts', 'aac', 'ac3', 'truehd', 'atmos', 'flac',
  'amzn', 'nf', 'dsnp', 'hmax', 'mubi', 'atvp', 'pcok',
  'proper', 'repack', 'extended', 'uncut',
];

const SERIES_RX = /\b[Ss](\d{1,2})[._\- ]?[Ee](\d{1,3})\b|\b(\d{1,2})x(\d{2})\b|\bSeason[ ._-]?(\d{1,2})\b/;

function parseFilename(raw: string): ParsedName {
  let s = raw.split('/').pop() ?? raw;
  if (s.includes('.')) s = s.substring(0, s.lastIndexOf('.'));
  s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  const ser = s.match(SERIES_RX);
  let season: number | undefined;
  let episode: number | undefined;
  let isSeries = false;
  if (ser) {
    isSeries = true;
    if (ser[1] && ser[2]) {
      season = Number(ser[1]);
      episode = Number(ser[2]);
    } else if (ser[3] && ser[4]) {
      season = Number(ser[3]);
      episode = Number(ser[4]);
    } else if (ser[5]) {
      season = Number(ser[5]);
    }
  }

  const lower = s.toLowerCase();
  let cutAt = s.length;
  for (const c of RELEASE_CUTS) {
    const i = lower.indexOf(c);
    if (i > 0 && i < cutAt) cutAt = i;
  }
  if (yearMatch && yearMatch.index !== undefined && yearMatch.index < cutAt) {
    cutAt = yearMatch.index;
  }
  if (ser && ser.index !== undefined && ser.index < cutAt) {
    cutAt = ser.index;
  }

  const title = s.substring(0, cutAt).replace(/[\-\(\[\s]+$/, '').trim() || s;
  return { title, year, season, episode, isSeries };
}

async function tmdbPoster(name: string, year: number | undefined, isSeries: boolean): Promise<{ poster?: string; backdrop?: string; overview?: string } | null> {
  if (!env.TMDB_API_KEY) return null;
  const key = `tmdb::${name}::${year ?? ''}::${isSeries ? 'tv' : 'mv'}`;
  const cached = tmdbCache.get(key);
  if (cached !== undefined) return cached;

  const tries: Array<{ kind: 'movie' | 'tv'; url: string }> = isSeries
    ? [
        { kind: 'tv',    url: `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&first_air_date_year=${year}` : ''}` },
        { kind: 'movie', url: `https://api.themoviedb.org/3/search/movie?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&year=${year}` : ''}` },
      ]
    : [
        { kind: 'movie', url: `https://api.themoviedb.org/3/search/movie?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&year=${year}` : ''}` },
        { kind: 'tv',    url: `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(name)}${year ? `&first_air_date_year=${year}` : ''}` },
      ];

  for (const t of tries) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), TMDB_TIMEOUT_MS);
      try {
        const { statusCode, body } = await request(t.url, { signal: ac.signal });
        if (statusCode === 429) {
          // Rate limited — give up for this item; cache the miss briefly so
          // we don't hammer.
          tmdbCache.set(key, null, 30 * 1000);
          return null;
        }
        if (statusCode < 200 || statusCode >= 300) continue;
        const json = await body.json() as { results?: Array<{ poster_path?: string; backdrop_path?: string; overview?: string }> };
        const hit = json.results?.[0];
        if (!hit) continue;
        const out = {
          poster:   hit.poster_path   ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : undefined,
          backdrop: hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : undefined,
          overview: hit.overview,
        };
        tmdbCache.set(key, out);
        return out;
      } finally {
        clearTimeout(to);
      }
    } catch { /* next */ }
  }
  tmdbCache.set(key, null);
  return null;
}

/**
 * Like Promise.all(arr.map(fn)) but never runs more than `concurrency`
 * promises at once. Preserves output order.
 */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
