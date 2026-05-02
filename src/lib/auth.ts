//
// Token-based device auth. Every request must carry x-install-token.
// Unknown tokens auto-register a new device row — first call succeeds, the
// device is then bound to that token forever.
//

import { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/pool.js';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
    installToken: string;
  }
}

export const authPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/healthz')) return;

    const token = (req.headers['x-install-token'] as string | undefined)?.trim();
    if (!token) {
      reply.code(401).send({ error: 'missing x-install-token header' });
      return;
    }
    if (token.length < 16 || token.length > 200) {
      reply.code(401).send({ error: 'malformed x-install-token' });
      return;
    }

    const existing = await db.query<{ id: string }>(
      'SELECT id FROM devices WHERE install_token = $1',
      [token]
    );

    let deviceId: string;
    if (existing.rowCount && existing.rowCount > 0) {
      deviceId = existing.rows[0]!.id;
      await db.query(
        'UPDATE devices SET last_seen_at = NOW() WHERE id = $1',
        [deviceId]
      );
    } else {
      deviceId = randomUUID();
      await db.query(
        `INSERT INTO devices (id, install_token, last_seen_at)
         VALUES ($1, $2, NOW())`,
        [deviceId, token]
      );
      app.log.info({ deviceId }, 'new device registered');
    }

    req.deviceId = deviceId;
    req.installToken = token;
  });
};
