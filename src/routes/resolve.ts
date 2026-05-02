//
// /resolve — turn a stream candidate (hoster URL or magnet) into a direct
// playable URL using the device's Real-Debrid token.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import {
  rdResolve, rdAddMagnet, rdSelectVideoFiles, rdWaitForTorrent,
} from '../lib/debrid.js';

export const resolveRoutes: FastifyPluginAsync = async (app) => {
  app.post('/resolve', async (req, reply) => {
    const body = z.object({
      provider: z.enum(['RD', 'AD', 'PM']).default('RD'),
      // Either a hoster URL or a magnet link.
      url: z.string().url().optional(),
      magnet: z.string().regex(/^magnet:\?/).optional(),
      infoHash: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
      // How long the server may wait for a magnet to finish before giving up
      // and returning 202. iOS picks small values (e.g. 4-8s) so the user
      // doesn't sit on a spinner forever.
      maxWaitMs: z.number().int().min(0).max(30_000).optional(),
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
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes, mimeType: out.mimeType };
      }
      const magnet = body.magnet ?? `magnet:?xt=urn:btih:${body.infoHash}`;
      const id = await rdAddMagnet(token, magnet);
      await rdSelectVideoFiles(token, id);
      const info = await rdWaitForTorrent(token, id, body.maxWaitMs ?? 6_000);
      const link = info.links?.[0];
      if (!link) {
        reply.code(202);
        return {
          status: info.status,
          progress: info.progress ?? 0,
          torrentId: id,
          message: info.status === 'downloaded'
            ? 'torrent downloaded but no direct link emitted yet — retry shortly'
            : 'magnet not yet ready on Real-Debrid — retry shortly',
        };
      }
      const out = await rdResolve(token, link);
      return {
        directURL: out.directURL,
        filename: out.filename,
        sizeBytes: out.sizeBytes,
        mimeType: out.mimeType,
        torrentId: id,
      };
    } catch (e) {
      reply.code(502);
      return { error: 'resolve failed', details: (e as Error).message };
    }
  });
};
