//
// /streams/:type/:id — fan out across enabled addons that publish stream
// resource, return merged list ranked by quality + cached-on-debrid first.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import {
  AddonManifest, baseURL, fetchStreams, StremioStream, supportsResource,
} from '../lib/stremio.js';
import { rdInstantAvailability } from '../lib/debrid.js';

interface RankedStream extends StremioStream {
  _addon: string;
  _quality: number;     // higher = better (3 = 4K, 2 = 1080p, 1 = 720p, 0 = unknown)
  _cached: boolean;     // RD already has it cached
}

function inferQuality(s: StremioStream): number {
  const text = `${s.title ?? ''} ${s.name ?? ''} ${s.qualityLabel ?? ''}`.toLowerCase();
  if (/2160|4k|uhd/.test(text)) return 3;
  if (/1080/.test(text)) return 2;
  if (/720/.test(text)) return 1;
  return 0;
}

export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/streams/:type/:id', async (req) => {
    const params = z.object({
      type: z.string(),
      id: z.string(),
    }).parse(req.params);

    const [addonsR, debridR] = await Promise.all([
      db.query<{ manifest_url: string; resources: unknown; types: unknown }>(
        `SELECT manifest_url, resources, types
           FROM addons
          WHERE device_id = $1 AND enabled = TRUE`,
        [req.deviceId]
      ),
      db.query<{ provider: string; token: string }>(
        `SELECT provider, token FROM debrid_tokens WHERE device_id = $1`,
        [req.deviceId]
      ),
    ]);
    const rdToken = debridR.rows.find(r => r.provider === 'RD')?.token;

    const collected: RankedStream[] = [];
    await Promise.all(addonsR.rows.map(async (row) => {
      const m: AddonManifest = {
        id: '', version: '', name: '',
        resources: row.resources as AddonManifest['resources'],
        types: row.types as string[],
      };
      if (!supportsResource(m, 'stream', params.type)) return;
      try {
        const r = await fetchStreams(baseURL(row.manifest_url), params.type, params.id);
        for (const s of r.streams ?? []) {
          collected.push({ ...s, _addon: row.manifest_url, _quality: inferQuality(s), _cached: false });
        }
      } catch (e) {
        app.log.warn({ err: (e as Error).message, addon: row.manifest_url }, 'streams failed');
      }
    }));

    // Cache-check infoHashes against RD if a token is present.
    if (rdToken) {
      const hashes = collected.map(s => s.infoHash).filter((h): h is string => !!h);
      const unique = [...new Set(hashes.map(h => h.toLowerCase()))];
      const checks = await Promise.all(unique.map(async (h) => [h, await rdInstantAvailability(rdToken, h)] as const));
      const cachedSet = new Set(checks.filter(([, v]) => v).map(([h]) => h));
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
