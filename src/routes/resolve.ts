//
// /resolve — turn a stream candidate (hoster URL or magnet) into a direct
// playable URL using the device's Real-Debrid token.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { rdResolve, rdAddMagnet, rdSelectAllFiles, rdTorrentInfo } from '../lib/debrid.js';

export const resolveRoutes: FastifyPluginAsync = async (app) => {
  app.post('/resolve', async (req, reply) => {
    const body = z.object({
      provider: z.enum(['RD', 'AD', 'PM']).default('RD'),
      // Either a hoster URL or a magnet link.
      url: z.string().url().optional(),
      magnet: z.string().regex(/^magnet:\?/).optional(),
      infoHash: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
    }).refine(d => d.url || d.magnet || d.infoHash, {
      message: 'one of url, magnet, infoHash is required',
    }).parse(req.body);

    const tok = await db.query<{ token: string }>(
      'SELECT token FROM debrid_tokens WHERE device_id = $1 AND provider = $2',
      [req.deviceId, body.provider]
    );
    const token = tok.rows[0]?.token;
    if (!token) {
      reply.code(400);
      return { error: `no ${body.provider} token configured` };
    }

    if (body.provider !== 'RD') {
      reply.code(501);
      return { error: `${body.provider} not yet implemented` };
    }

    try {
      if (body.url) {
        const out = await rdResolve(token, body.url);
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
      }
      if (body.magnet) {
        const id = await rdAddMagnet(token, body.magnet);
        await rdSelectAllFiles(token, id);
        const info = await rdTorrentInfo(token, id);
        const link = info.links?.[0];
        if (!link) {
          reply.code(202);
          return { status: info.status, message: 'magnet queued, no direct link yet — retry shortly' };
        }
        const out = await rdResolve(token, link);
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
      }
      if (body.infoHash) {
        const magnet = `magnet:?xt=urn:btih:${body.infoHash}`;
        const id = await rdAddMagnet(token, magnet);
        await rdSelectAllFiles(token, id);
        const info = await rdTorrentInfo(token, id);
        const link = info.links?.[0];
        if (!link) {
          reply.code(202);
          return { status: info.status, message: 'magnet queued, no direct link yet — retry shortly' };
        }
        const out = await rdResolve(token, link);
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
      }
      reply.code(400);
      return { error: 'no resolvable input' };
    } catch (e) {
      reply.code(502);
      return { error: 'resolve failed', details: (e as Error).message };
    }
  });
};
