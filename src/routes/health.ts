import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/pool.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => {
    const r = await db.query<{ ok: number }>('SELECT 1 AS ok');
    return { status: 'ok', db: r.rows[0]?.ok === 1 };
  });
};
