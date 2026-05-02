//
// /catalogs and /catalog/:type/:id — list and fetch Stremio addon catalogs
// for the device, with artwork normalised so the iOS homepage can decode
// covers without per-source poster/backdrop dialect handling.
//
// Without this route the addon list `/v1/addons` was the only place catalog
// metadata was exposed — which meant adding addons did nothing visible.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import {
  AddonManifest, baseURL, fetchCatalog, supportsResource, StremioMetaPreview,
} from '../lib/stremio.js';
import { TTLCache } from '../lib/cache.js';
import { normalizeArtwork } from '../lib/artwork.js';

interface ManifestCatalog {
  id: string;
  type: string;
  name: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
}

const cache = new TTLCache<{ metas: StremioMetaPreview[] }>(5 * 60 * 1000);

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  // List every catalog advertised by every enabled addon. iOS uses this to
  // build the "rows" of the homepage (each catalog = one horizontal rail).
  app.get('/catalogs', async (req) => {
    const r = await db.query<{ manifest_url: string; name: string; catalogs: unknown }>(
      `SELECT manifest_url, name, catalogs
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE`,
      [req.deviceId]
    );

    const out: Array<{
      addon: string;
      addonName: string;
      type: string;
      id: string;
      name: string;
      hasSearch: boolean;
      requiredExtra: string[];
      optionalExtra: string[];
    }> = [];
    for (const row of r.rows) {
      const cats = (row.catalogs as ManifestCatalog[] | null) ?? [];
      for (const c of cats) {
        const required = (c.extra ?? []).filter(e => e.isRequired).map(e => e.name);
        const optional = (c.extra ?? []).filter(e => !e.isRequired).map(e => e.name);
        const hasSearch = (c.extra ?? []).some(e => e.name === 'search');
        out.push({
          addon: row.manifest_url,
          addonName: row.name,
          type: c.type,
          id: c.id,
          name: c.name,
          hasSearch,
          requiredExtra: required,
          optionalExtra: optional,
        });
      }
    }
    return { catalogs: out };
  });

  // Fan out a catalog request to any enabled addon that publishes the (type,id)
  // pair. Results are de-duplicated by id and capped, with artwork normalised.
  // Use ?addon=<manifest_url> to scope to a single addon.
  app.get('/catalog/:type/:id', async (req) => {
    const params = z.object({
      type: z.string().min(1).max(40),
      id: z.string().min(1).max(120),
    }).parse(req.params);

    const q = z.object({
      addon: z.string().url().optional(),
      genre: z.string().optional(),
      skip: z.coerce.number().int().min(0).optional(),
      search: z.string().min(1).max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(80),
    }).parse(req.query);

    const r = await db.query<{ manifest_url: string; resources: unknown; types: unknown; catalogs: unknown }>(
      `SELECT manifest_url, resources, types, catalogs
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE
          AND ($2::text IS NULL OR manifest_url = $2)`,
      [req.deviceId, q.addon ?? null]
    );

    const extras: Record<string, string> = {};
    if (q.genre)  extras.genre  = q.genre;
    if (q.search) extras.search = q.search;
    if (q.skip != null) extras.skip = String(q.skip);

    const seen = new Set<string>();
    const merged: Array<StremioMetaPreview & { _addon: string }> = [];

    await Promise.all(r.rows.map(async (row) => {
      const m: AddonManifest = {
        id: '', version: '', name: '',
        resources: row.resources as AddonManifest['resources'],
        types: row.types as string[],
      };
      if (!supportsResource(m, 'catalog', params.type)) return;

      // Skip addons whose catalog list doesn't include this exact (type, id) —
      // some addons advertise the catalog resource but not this catalog id.
      const cats = (row.catalogs as ManifestCatalog[] | null) ?? [];
      const matching = cats.find(c => c.type === params.type && c.id === params.id);
      if (cats.length > 0 && !matching) return;

      const base = baseURL(row.manifest_url);
      const cacheKey = `${base}::${params.type}::${params.id}::${JSON.stringify(extras)}`;
      try {
        const items = await cache.memoize(cacheKey, () => fetchCatalog(base, params.type, params.id, extras));
        for (const it of items.metas ?? []) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          merged.push({ ...it, _addon: row.manifest_url });
        }
      } catch (e) {
        app.log.warn({ err: (e as Error).message, addon: base }, 'catalog fetch failed');
      }
    }));

    const top = merged.slice(0, q.limit);
    const items = await Promise.all(top.map(async (m) => {
      const art = await normalizeArtwork({
        titleId: m.id,
        poster: m.poster,
        background: m.background,
      });
      return { ...m, ...art };
    }));

    return {
      type: params.type,
      id: params.id,
      count: items.length,
      items,
    };
  });
};
