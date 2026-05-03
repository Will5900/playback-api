//
// /v2 — TMDB-backed content discovery. Replaces Stremio addon passthrough
// for browse/search/detail. Streams still fan out to Stremio addons via
// the device's installed addon list.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as tmdb from '../lib/tmdb.js';
import { db } from '../db/pool.js';
import {
  baseURL, fetchStreams, supportsResource,
  type AddonManifest, type StremioStream,
} from '../lib/stremio.js';
import {
  rdInstantAvailability, adInstantAvailability, pmInstantAvailability,
} from '../lib/debrid.js';

export const v2Routes: FastifyPluginAsync = async (app) => {

  // ----- GET /home -----

  app.get('/home', async () => {
    if (!tmdb.isConfigured()) return { heroes: [], rows: [] };

    const providers = [
      { id: 8, name: 'Netflix' },
      { id: 337, name: 'Disney+' },
      { id: 9, name: 'Prime Video' },
      { id: 1899, name: 'Max' },
      { id: 350, name: 'Apple TV+' },
      { id: 15, name: 'Hulu' },
      { id: 531, name: 'Paramount+' },
    ];

    const [
      trendingMovies, trendingSeries,
      latestMovies, latestSeries,
      ...providerResults
    ] = await Promise.all([
      tmdb.trending('movie', 'week'),
      tmdb.trending('tv', 'week'),
      tmdb.nowPlaying(),
      tmdb.onTheAir(),
      ...providers.flatMap(p => [
        tmdb.discoverByProvider('movie', p.id),
        tmdb.discoverByProvider('tv', p.id),
      ]),
    ]);

    const rows: Array<{ id: string; title: string; type: string; titles: tmdb.V2Title[] }> = [
      { id: 'trending-movies', title: 'Trending Movies', type: 'movie', titles: trendingMovies.slice(0, 20) },
      { id: 'trending-series', title: 'Trending Series', type: 'series', titles: trendingSeries.slice(0, 20) },
      { id: 'latest-movies', title: 'Latest Movies', type: 'movie', titles: latestMovies.slice(0, 20) },
      { id: 'latest-series', title: 'Latest Series', type: 'series', titles: latestSeries.slice(0, 20) },
    ];

    for (let i = 0; i < providers.length; i++) {
      const movies = providerResults[i * 2] as tmdb.V2Title[];
      const shows = providerResults[i * 2 + 1] as tmdb.V2Title[];
      const slug = providers[i].name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (movies.length > 0) {
        rows.push({
          id: `${slug}-movies`,
          title: `${providers[i].name} Movies`,
          type: 'movie',
          titles: movies.slice(0, 20),
        });
      }
      if (shows.length > 0) {
        rows.push({
          id: `${slug}-series`,
          title: `${providers[i].name} Shows`,
          type: 'series',
          titles: shows.slice(0, 20),
        });
      }
    }

    return {
      heroes: trendingMovies.slice(0, 5),
      rows,
    };
  });

  // ----- GET /trending/:window -----

  app.get('/trending/:window', async (req) => {
    const { window } = z.object({
      window: z.enum(['day', 'week']),
    }).parse(req.params);

    const titles = await tmdb.trending('all', window);
    return { window, titles };
  });

  // ----- GET /search -----

  app.get('/search', async (req) => {
    const q = z.object({
      q: z.string().min(1).max(200),
      type: z.enum(['movie', 'series']).optional(),
    }).parse(req.query);

    const tmdbType = q.type === 'series' ? 'tv' : q.type === 'movie' ? 'movie' : undefined;
    const results = await tmdb.search(q.q, tmdbType);
    return { query: q.q, results };
  });

  // ----- GET /genres -----

  app.get('/genres', async (req) => {
    const q = z.object({
      type: z.enum(['movie', 'tv']).default('movie'),
    }).parse(req.query);

    const genres = await tmdb.genreList(q.type);
    return { genres };
  });

  // ----- GET /genre/:id -----

  app.get('/genre/:id', async (req) => {
    const params = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      type: z.enum(['movie', 'tv']).default('movie'),
    }).parse(req.query);

    const result = await tmdb.discover(query.type, params.id, query.page);
    const genres = await tmdb.genreList(query.type);
    const genre = genres.find(g => g.id === params.id) ?? { id: params.id, name: 'Unknown' };

    return {
      genre,
      titles: result.titles,
      page: result.page,
      totalPages: result.totalPages,
    };
  });

  // ----- GET /title/:type/:id -----

  app.get('/title/:type/:id', async (req, reply) => {
    const params = z.object({
      type: z.enum(['movie', 'series']),
      id: z.string().min(1),
    }).parse(req.params);

    let tmdbId: number;
    let tmdbType: 'movie' | 'tv' = params.type === 'series' ? 'tv' : 'movie';

    if (params.id.startsWith('tt')) {
      const found = await tmdb.findByImdbID(params.id);
      if (!found?.id) {
        reply.code(404);
        return { error: 'title not found' };
      }
      tmdbId = found.id;
      if (found.type) tmdbType = found.type;
    } else {
      tmdbId = parseInt(params.id, 10);
      if (isNaN(tmdbId)) {
        reply.code(400);
        return { error: 'invalid id' };
      }
    }

    const detail = tmdbType === 'movie'
      ? await tmdb.movieDetail(tmdbId)
      : await tmdb.tvDetail(tmdbId);

    if (!detail) {
      reply.code(404);
      return { error: 'title not found' };
    }
    return detail;
  });

  // ----- GET /title/series/:id/season/:season -----

  app.get('/title/series/:id/season/:season', async (req, reply) => {
    const params = z.object({
      id: z.string().min(1),
      season: z.coerce.number().int().min(1),
    }).parse(req.params);

    let tmdbId: number;
    if (params.id.startsWith('tt')) {
      const found = await tmdb.findByImdbID(params.id);
      if (!found?.id) { reply.code(404); return { error: 'title not found' }; }
      tmdbId = found.id;
    } else {
      tmdbId = parseInt(params.id, 10);
      if (isNaN(tmdbId)) { reply.code(400); return { error: 'invalid id' }; }
    }

    const episodes = await tmdb.tvSeasonEpisodes(tmdbId, params.season);
    return { season: params.season, episodes: episodes ?? [] };
  });

  // ----- GET /title/:type/:id/streams -----
  // Resolves TMDB ID → IMDb ID, then fans out to Stremio addons (same as v1).

  app.get('/title/:type/:id/streams', async (req, reply) => {
    const params = z.object({
      type: z.enum(['movie', 'series']),
      id: z.string().min(1),
    }).parse(req.params);

    const stremioType = params.type === 'series' ? 'series' : 'movie';
    let imdbId: string;

    if (params.id.startsWith('tt')) {
      imdbId = params.id;
    } else {
      const tmdbId = parseInt(params.id, 10);
      if (isNaN(tmdbId)) {
        reply.code(400);
        return { error: 'invalid id' };
      }
      const tmdbType = params.type === 'series' ? 'tv' : 'movie';
      const ext = await tmdb.externalIds(tmdbType, tmdbId);
      if (!ext?.imdbId) {
        reply.code(404);
        return { error: 'no IMDb mapping for this title' };
      }
      imdbId = ext.imdbId;
    }

    // Fan out to installed Stremio addons
    const [addonsR, debridR] = await Promise.all([
      db.query<{ manifest_url: string; resources: unknown; types: unknown }>(
        `SELECT manifest_url, resources, types
           FROM addons
          WHERE device_id = $1 AND enabled = TRUE`,
        [req.deviceId],
      ),
      db.query<{ provider: string; token: string }>(
        `SELECT provider, token FROM debrid_tokens WHERE device_id = $1`,
        [req.deviceId],
      ),
    ]);

    const rdToken = debridR.rows.find(r => r.provider === 'RD')?.token;
    const adToken = debridR.rows.find(r => r.provider === 'AD')?.token;
    const pmToken = debridR.rows.find(r => r.provider === 'PM')?.token;

    interface RankedStream extends StremioStream {
      _addon: string;
      _quality: number;
      _cached: boolean;
    }

    function inferQuality(s: StremioStream): number {
      const text = `${s.title ?? ''} ${s.name ?? ''} ${(s as Record<string, unknown>).qualityLabel ?? ''}`.toLowerCase();
      if (/2160|4k|uhd/.test(text)) return 3;
      if (/1080/.test(text)) return 2;
      if (/720/.test(text)) return 1;
      return 0;
    }

    const collected: RankedStream[] = [];
    await Promise.all(addonsR.rows.map(async (row) => {
      const m: AddonManifest = {
        id: '', version: '', name: '',
        resources: row.resources as AddonManifest['resources'],
        types: row.types as string[],
      };
      if (!supportsResource(m, 'stream', stremioType)) return;
      try {
        const r = await fetchStreams(baseURL(row.manifest_url), stremioType, imdbId);
        for (const s of r.streams ?? []) {
          collected.push({ ...s, _addon: row.manifest_url, _quality: inferQuality(s), _cached: false });
        }
      } catch (e) {
        app.log.warn({ err: (e as Error).message, addon: row.manifest_url }, 'v2 streams failed');
      }
    }));

    // Debrid cache check
    const hashes = collected.map(s => s.infoHash).filter((h): h is string => !!h);
    const unique = [...new Set(hashes.map(h => h.toLowerCase()))];
    if (unique.length > 0) {
      const cachedSet = new Set<string>();
      await Promise.all(unique.map(async (h) => {
        if (rdToken && await rdInstantAvailability(rdToken, h)) cachedSet.add(h);
        else if (adToken && await adInstantAvailability(adToken, h)) cachedSet.add(h);
        else if (pmToken && await pmInstantAvailability(pmToken, h)) cachedSet.add(h);
      }));
      for (const s of collected) {
        if (s.infoHash && cachedSet.has(s.infoHash.toLowerCase())) s._cached = true;
      }
    }

    collected.sort((a, b) => {
      if (a._cached !== b._cached) return a._cached ? -1 : 1;
      if (a._quality !== b._quality) return b._quality - a._quality;
      return (b.seeders ?? 0) - (a.seeders ?? 0);
    });

    return { type: params.type, id: params.id, streams: collected.slice(0, 60) };
  });
};
