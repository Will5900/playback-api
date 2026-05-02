//
// /meta/:type/:id — return the first non-empty meta from any addon that
// supports the given (type, id), enriched with TMDB poster/backdrop when
// the id is an imdb id.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { baseURL, fetchMeta, supportsResource, AddonManifest, fetchManifest } from '../lib/stremio.js';
import { TTLCache } from '../lib/cache.js';
import { findByImdbID } from '../lib/tmdb.js';

const cache = new TTLCache<unknown>(15 * 60 * 1000); // 15 min

export const metaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/meta/:type/:id', async (req) => {
    const params = z.object({
      type: z.string(),
      id: z.string(),
    }).parse(req.params);

    const cacheKey = `meta::${req.deviceId}::${params.type}::${params.id}`;
    return cache.memoize(cacheKey, async () => {
      const addons = await db.query<{ manifest_url: string; resources: unknown; types: unknown }>(
        `SELECT manifest_url, resources, types
           FROM addons
          WHERE device_id = $1 AND enabled = TRUE`,
        [req.deviceId]
      );

      // Build a synthetic AddonManifest just enough to call supportsResource.
      for (const row of addons.rows) {
        const m: AddonManifest = {
          id: '', version: '', name: '',
          resources: row.resources as AddonManifest['resources'],
          types: row.types as string[],
        };
        if (!supportsResource(m, 'meta', params.type)) continue;
        try {
          const r = await fetchMeta(baseURL(row.manifest_url), params.type, params.id);
          if (r?.meta) {
            const enriched = { ...r.meta };
            if (params.id.startsWith('tt')) {
              const tmdb = await findByImdbID(params.id);
              if (tmdb) {
                enriched.poster = enriched.poster ?? tmdb.poster;
                enriched.background = enriched.background ?? tmdb.backdrop;
                enriched.description = enriched.description ?? tmdb.overview;
              }
            }
            return { meta: enriched, source: row.manifest_url };
          }
        } catch (e) {
          app.log.warn({ err: (e as Error).message, addon: row.manifest_url }, 'meta failed');
        }
      }

      // Fallback to bare TMDB if no addon answered.
      if (params.id.startsWith('tt')) {
        const tmdb = await findByImdbID(params.id);
        if (tmdb) {
          return {
            meta: {
              id: params.id,
              type: params.type,
              name: params.id,
              poster: tmdb.poster,
              background: tmdb.backdrop,
              description: tmdb.overview,
            },
            source: 'tmdb',
          };
        }
      }
      return { meta: null, source: null };
    });
  });

  // Manual refresh — bypass cache.
  app.post('/meta/:type/:id/refresh', async (req) => {
    const params = z.object({ type: z.string(), id: z.string() }).parse(req.params);
    cache.set(`meta::${req.deviceId}::${params.type}::${params.id}`, undefined as unknown, -1);
    return { ok: true };
  });

  // Internal: refresh stale manifests.
  app.post('/addons/refresh-stale', async () => {
    const stale = await db.query(
      `SELECT id, manifest_url FROM addons
        WHERE last_fetched_at IS NULL OR last_fetched_at < NOW() - INTERVAL '6 hours'`
    );
    for (const row of stale.rows) {
      try {
        const { manifest } = await fetchManifest(row.manifest_url);
        await db.query(
          `UPDATE addons SET name=$1, version=$2, description=$3,
                              resources=$4::jsonb, types=$5::jsonb, catalogs=$6::jsonb,
                              last_fetched_at = NOW()
            WHERE id = $7`,
          [manifest.name, manifest.version, manifest.description ?? null,
           JSON.stringify(manifest.resources), JSON.stringify(manifest.types),
           JSON.stringify(manifest.catalogs ?? []), row.id]
        );
      } catch (e) {
        app.log.warn({ err: (e as Error).message, id: row.id }, 'refresh failed');
      }
    }
    return { refreshed: stale.rowCount };
  });
};
