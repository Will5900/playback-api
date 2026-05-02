//
// Playback API entrypoint. Fastify + Postgres. Single process, run behind
// Caddy on api.tonebreak.com. All routes prefixed with /v1.
//

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import { env } from './lib/env.js';
import { db } from './db/pool.js';
import { authPlugin } from './lib/auth.js';

import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { rdRoutes } from './routes/rd.js';
import { addonRoutes } from './routes/addons.js';
import { searchRoutes } from './routes/search.js';
import { metaRoutes } from './routes/meta.js';
import { streamRoutes } from './routes/streams.js';
import { resolveRoutes } from './routes/resolve.js';
import { subtitleRoutes } from './routes/subtitles.js';
import { watchRoutes } from './routes/watch.js';

async function main() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ORIGIN.split(',').map(s => s.trim()) });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers['x-install-token'] as string) || req.ip,
  });
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(meRoutes,        { prefix: '/v1' });
  await app.register(rdRoutes,        { prefix: '/v1' });
  await app.register(addonRoutes,     { prefix: '/v1' });
  await app.register(searchRoutes,    { prefix: '/v1' });
  await app.register(metaRoutes,      { prefix: '/v1' });
  await app.register(streamRoutes,    { prefix: '/v1' });
  await app.register(resolveRoutes,   { prefix: '/v1' });
  await app.register(subtitleRoutes,  { prefix: '/v1' });
  await app.register(watchRoutes,     { prefix: '/v1' });

  // Boot Postgres — fail fast if it can't reach the DB.
  await db.query('SELECT 1');

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`playback-api up on :${env.PORT}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
