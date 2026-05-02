//
// /v1/catalogs           — list every catalog from every enabled addon
// /v1/catalog/:type/:id  — fetch one catalog (optionally with `extra` qs)
//
// Implements Stremio's catalog resource:
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/catalog.md
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { baseURL, fetchCatalog } from '../lib/stremio.js';
import { TTLCache } from '../lib/cache.js';

const cache = new TTLCache<unknown>(5 * 60 * 1000); // 5 min

interface CatalogManifest {
  id: string;
  type: string;
  name: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Aggregated list of all catalogs across all enabled addons. Used by
   * Discover to render its row layout. Each catalog tagged with its
   * addon manifest URL so the iOS client can fetch its contents.
   */
  app.get('/catalogs', async (req) => {
    const r = await db.query<{ manifest_url: string; name: string; catalogs: unknown }>(
      `SELECT manifest_url, name, catalogs
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE`,
      [req.deviceId]
    );
    const flat: Array<CatalogManifest & { addon: string; addonName: string }> = [];
    for (const row of r.rows) {
      const cats = (row.catalogs as CatalogManifest[]) ?? [];
      for (const c of cats) {
        flat.push({ ...c, addon: row.manifest_url, addonName: row.name });
      }
    }
    return { count: flat.length, catalogs: flat };
  });

  /**
   * Fetch one catalog's items.
   * Query string forwards Stremio extra params (genre, skip, search, etc.)
   * The `addon` qs param picks which addon manifest to ask — without it
   * we try the first enabled addon that publishes a matching catalog.
   */
  app.get('/catalog/:type/:id', async (req, reply) => {
    const params = z.object({
      type: z.string(),
      id: z.string(),
    }).parse(req.params);
    const q = z.object({
      addon: z.string().url().optional(),
      genre: z.string().optional(),
      skip: z.coerce.number().nonnegative().optional(),
      search: z.string().optional(),
    }).parse(req.query);

    const r = await db.query<{ manifest_url: string; catalogs: unknown }>(
      `SELECT manifest_url, catalogs
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE
          ${q.addon ? 'AND manifest_url = $2' : ''}`,
      q.addon ? [req.deviceId, q.addon] : [req.deviceId]
    );

    const candidates = r.rows.filter((row) => {
      const cats = (row.catalogs as CatalogManifest[]) ?? [];
      return cats.some(c => c.type === params.type && c.id === params.id);
    });

    if (candidates.length === 0) {
      reply.code(404);
      return { error: 'no enabled addon publishes this catalog', type: params.type, id: params.id };
    }

    const extra: Record<string, string> = {};
    if (q.genre)  extra.genre  = q.genre;
    if (q.skip != null) extra.skip = String(q.skip);
    if (q.search) extra.search = q.search;

    const cacheKey = `cat::${req.deviceId}::${candidates[0]!.manifest_url}::${params.type}::${params.id}::${JSON.stringify(extra)}`;
    return cache.memoize(cacheKey, async () => {
      try {
        const result = await fetchCatalog(baseURL(candidates[0]!.manifest_url), params.type, params.id, extra);
        return {
          source: candidates[0]!.manifest_url,
          metas: result.metas ?? [],
        };
      } catch (e) {
        reply.code(502);
        return { error: 'addon catalog fetch failed', details: (e as Error).message };
      }
    });
  });
};
