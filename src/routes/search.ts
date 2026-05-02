//
// /search — fan out a query across every enabled catalog of every enabled
// addon for the current device, dedupe by id, return a merged list.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { baseURL, fetchCatalog, StremioMetaPreview } from '../lib/stremio.js';
import { TTLCache } from '../lib/cache.js';

const cache = new TTLCache<StremioMetaPreview[]>(2 * 60 * 1000); // 2 min per (addon, query)

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/search', async (req) => {
    const q = z.object({
      q: z.string().min(1).max(120),
      type: z.enum(['movie', 'series', 'tv']).optional(),
    }).parse(req.query);

    const addons = await db.query(
      `SELECT manifest_url, catalogs
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE`,
      [req.deviceId]
    );

    const seen = new Set<string>();
    const merged: Array<StremioMetaPreview & { _addon: string }> = [];

    await Promise.all(addons.rows.map(async (row) => {
      const cats = (row.catalogs as Array<{ id: string; type: string; extra?: Array<{ name: string }> }>) ?? [];
      const base = baseURL(row.manifest_url);
      const searchable = cats.filter(c =>
        (q.type ? c.type === q.type : true) &&
        (c.extra ?? []).some(e => e.name === 'search')
      );
      for (const c of searchable) {
        const key = `${base}::${c.type}::${c.id}::${q.q}`;
        try {
          const items = await cache.memoize(key, async () => {
            const r = await fetchCatalog(base, c.type, c.id, { search: q.q });
            return r.metas ?? [];
          });
          for (const it of items) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            merged.push({ ...it, _addon: row.manifest_url });
          }
        } catch (e) {
          app.log.warn({ err: (e as Error).message, addon: base }, 'search failed');
        }
      }
    }));

    return { query: q.q, count: merged.length, results: merged.slice(0, 80) };
  });
};
