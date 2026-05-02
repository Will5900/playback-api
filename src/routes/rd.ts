//
// /me/rd-library — proxy Real-Debrid downloads enriched with TMDB posters.
// Single round-trip from iOS instead of N (one per item).
//

import { FastifyPluginAsync } from 'fastify';
import { request } from 'undici';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { env } from '../lib/env.js';
import { TTLCache } from '../lib/cache.js';
import { normalizeArtworkSync } from '../lib/artwork.js';

const cache = new TTLCache<unknown>(10 * 60 * 1000); // 10 min

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
  // All four point at the same URL — see lib/artwork.ts.
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

const RD_FETCH_TIMEOUT_MS = 10_000;

export const rdRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/rd-library', async (req, reply) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      page: z.coerce.number().int().min(1).default(1),
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

    let downloads: RDDownload[];
    try {
      downloads = await fetchDownloads(token, q.limit, q.page);
    } catch (e) {
      reply.code(502);
      return { error: 'Real-Debrid fetch failed', details: (e as Error).message };
    }

    const enriched = await Promise.all(
      downloads.map(async (d): Promise<EnrichedRD> => {
        const ext = d.filename.includes('.') ? d.filename.split('.').pop()!.toLowerCase() : '';
        const parsed = parseFilename(d.filename);
        const tmdb = await tmdbPoster(parsed.title, parsed.year, parsed.isSeries);
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
      })
    );

    return { count: enriched.length, page: q.page, items: enriched };
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

// Common release-tag tokens that mark the end of the title segment in a
// scene-style filename. The earliest occurrence in the cleaned string is
// where the title stops.
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
  // Strip directory and extension.
  let s = raw.split('/').pop() ?? raw;
  if (s.includes('.')) s = s.substring(0, s.lastIndexOf('.'));
  s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Year first — used to truncate the title at the year boundary too.
  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  // Series markers.
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

  // Find the earliest cut: release tag, year, or series marker.
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
  const cached = cache.get(key) as { poster?: string; backdrop?: string; overview?: string } | undefined;
  if (cached !== undefined) return cached;

  // Probe the most likely kind first based on filename heuristics, then the other.
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
      const to = setTimeout(() => ac.abort(), 5_000);
      try {
        const { statusCode, body } = await request(t.url, { signal: ac.signal });
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
      } finally {
        clearTimeout(to);
      }
    } catch { /* next */ }
  }
  cache.set(key, null);
  return null;
}
