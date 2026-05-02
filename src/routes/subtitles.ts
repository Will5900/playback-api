//
// /subtitles/:type/:id — first try Stremio addons that publish subtitles,
// then fall back to OpenSubtitles REST when an API key is set.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { request } from 'undici';
import { db } from '../db/pool.js';
import {
  AddonManifest, baseURL, fetchSubtitles, supportsResource, StremioSubtitle,
} from '../lib/stremio.js';
import { env } from '../lib/env.js';

export const subtitleRoutes: FastifyPluginAsync = async (app) => {
  app.get('/subtitles/:type/:id', async (req) => {
    const params = z.object({ type: z.string(), id: z.string() }).parse(req.params);
    const q = z.object({ lang: z.string().optional() }).parse(req.query);

    const addons = await db.query<{ manifest_url: string; resources: unknown; types: unknown }>(
      `SELECT manifest_url, resources, types
         FROM addons
        WHERE device_id = $1 AND enabled = TRUE`,
      [req.deviceId]
    );

    const collected: StremioSubtitle[] = [];
    await Promise.all(addons.rows.map(async (row) => {
      const m: AddonManifest = {
        id: '', version: '', name: '',
        resources: row.resources as AddonManifest['resources'],
        types: row.types as string[],
      };
      if (!supportsResource(m, 'subtitles', params.type)) return;
      try {
        const r = await fetchSubtitles(baseURL(row.manifest_url), params.type, params.id);
        for (const s of r.subtitles ?? []) {
          if (q.lang && !s.lang.toLowerCase().startsWith(q.lang.toLowerCase())) continue;
          collected.push(s);
        }
      } catch { /* ignore */ }
    }));

    if (collected.length === 0 && env.OPENSUBTITLES_API_KEY && params.id.startsWith('tt')) {
      try {
        const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
        url.searchParams.set('imdb_id', params.id.replace(/^tt/, ''));
        if (q.lang) url.searchParams.set('languages', q.lang);
        const { statusCode, body } = await request(url.toString(), {
          headers: {
            'api-key': env.OPENSUBTITLES_API_KEY,
            'user-agent': env.OPENSUBTITLES_USER_AGENT,
          },
        });
        if (statusCode >= 200 && statusCode < 300) {
          const json = await body.json() as { data?: Array<{ id: string; attributes: { language: string; files: Array<{ file_id: number }> } }> };
          for (const item of json.data ?? []) {
            const fid = item.attributes.files[0]?.file_id;
            if (!fid) continue;
            collected.push({
              id: item.id,
              lang: item.attributes.language,
              url: `https://api.opensubtitles.com/api/v1/download?file_id=${fid}`,
            });
          }
        }
      } catch (e) {
        app.log.warn({ err: (e as Error).message }, 'opensubtitles failed');
      }
    }

    return { count: collected.length, subtitles: collected };
  });
};
