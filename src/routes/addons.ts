//
// /addons — manage installed Stremio addon manifests.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { fetchManifest, manifestURL } from '../lib/stremio.js';

export const addonRoutes: FastifyPluginAsync = async (app) => {
  app.get('/addons', async (req) => {
    const r = await db.query(
      `SELECT id, manifest_url AS "manifestUrl", name, version, description,
              resources, types, catalogs, enabled,
              added_at AS "addedAt", last_fetched_at AS "lastFetchedAt"
         FROM addons
        WHERE device_id = $1
        ORDER BY added_at DESC`,
      [req.deviceId]
    );
    // Stremio addons can list resources as either bare strings or
    // { name, types, idPrefixes } objects — normalise to plain strings
    // so the iOS Codable contract stays simple.
    const addons = r.rows.map((row: any) => ({
      ...row,
      resources: Array.isArray(row.resources)
        ? row.resources.map((x: any) => typeof x === 'string' ? x : (x?.name ?? '')).filter((x: string) => x)
        : [],
      types: Array.isArray(row.types) ? row.types : [],
    }));
    return { addons };
  });

  app.post('/addons', async (req, reply) => {
    const body = z.object({ manifestUrl: z.string().url() }).parse(req.body);
    const url = manifestURL(body.manifestUrl);
    let m;
    try {
      m = (await fetchManifest(url)).manifest;
    } catch (e) {
      reply.code(400);
      return { error: 'manifest fetch failed', details: (e as Error).message };
    }
    const r = await db.query(
      `INSERT INTO addons (device_id, manifest_url, name, version, description,
                           resources, types, catalogs, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
       ON CONFLICT (device_id, manifest_url) DO UPDATE
         SET name = EXCLUDED.name,
             version = EXCLUDED.version,
             description = EXCLUDED.description,
             resources = EXCLUDED.resources,
             types = EXCLUDED.types,
             catalogs = EXCLUDED.catalogs,
             last_fetched_at = NOW(),
             enabled = TRUE
       RETURNING id`,
      [
        req.deviceId,
        url,
        m.name,
        m.version,
        m.description ?? null,
        JSON.stringify(m.resources),
        JSON.stringify(m.types),
        JSON.stringify(m.catalogs ?? []),
      ]
    );
    reply.code(201);
    return { id: r.rows[0]!.id, manifest: m };
  });

  app.patch('/addons/:id', async (req) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    await db.query(
      `UPDATE addons SET enabled = $1
        WHERE id = $2 AND device_id = $3`,
      [body.enabled, params.id, req.deviceId]
    );
    return { ok: true };
  });

  app.delete('/addons/:id', async (req) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query(
      'DELETE FROM addons WHERE id = $1 AND device_id = $2',
      [params.id, req.deviceId]
    );
    return { ok: true };
  });
};
