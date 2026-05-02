//
// Validated env. Throws at boot if anything required is missing.
//

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  INSTALL_TOKEN_PEPPER: z.string().min(16),

  TMDB_API_KEY: z.string().optional(),
  FANART_API_KEY: z.string().optional(),
  OPENSUBTITLES_API_KEY: z.string().optional(),
  OPENSUBTITLES_USER_AGENT: z.string().default('Playback v0.1'),

  TRAKT_CLIENT_ID: z.string().optional(),
  TRAKT_CLIENT_SECRET: z.string().optional(),
  TRAKT_REDIRECT_URI: z.string().optional(),
  TRAKT_APP_REDIRECT: z.string().default('playback://trakt-callback'),

  CORS_ORIGIN: z.string().default('*'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
