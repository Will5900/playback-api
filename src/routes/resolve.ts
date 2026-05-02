//
// /resolve — turn a stream candidate (hoster URL or magnet) into a direct
// playable URL using the device's Real-Debrid token.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import {
  rdResolve, rdAddMagnet, rdSelectAllFiles, rdTorrentInfo,
  adResolve, pmResolve,
} from '../lib/debrid.js';

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

    try {
      if (body.provider === 'RD') {
        return await resolveRD(token, body, reply);
      }
      if (body.provider === 'AD') {
        // AllDebrid prefers a hoster URL or a magnet/hash converted to magnet.
        const link = body.url
          ?? body.magnet
          ?? (body.infoHash ? `magnet:?xt=urn:btih:${body.infoHash}` : undefined);
        if (!link) { reply.code(400); return { error: 'no link' }; }
        const out = await adResolve(token, link);
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
      }
      if (body.provider === 'PM') {
        const link = body.url
          ?? body.magnet
          ?? (body.infoHash ? `magnet:?xt=urn:btih:${body.infoHash}` : undefined);
        if (!link) { reply.code(400); return { error: 'no link' }; }
        const out = await pmResolve(token, link);
        return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
      }
      reply.code(400);
      return { error: 'unknown provider' };
    } catch (e) {
      reply.code(502);
      return { error: 'resolve failed', details: (e as Error).message };
    }
  });
};

async function resolveRD(token: string, body: { url?: string; magnet?: string; infoHash?: string }, reply: any) {
  if (body.url) {
    const out = await rdResolve(token, body.url);
    return { directURL: out.directURL, filename: out.filename, sizeBytes: out.sizeBytes };
  }
  const magnet = body.magnet ?? (body.infoHash ? `magnet:?xt=urn:btih:${body.infoHash}` : undefined);
  if (!magnet) { reply.code(400); return { error: 'no resolvable input' }; }
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
