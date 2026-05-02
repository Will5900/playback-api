//
// Trakt OAuth dance + scrobble proxy.
//
// Flow:
//   1. iOS calls POST /v1/me/trakt/start          → returns { authorizeURL }
//   2. iOS opens Safari at authorizeURL           (user logs into Trakt)
//   3. Trakt redirects to /v1/me/trakt/callback   → backend exchanges code,
//      stores tokens, then 302's into TRAKT_APP_REDIRECT (custom scheme so
//      iOS app reopens with success).
//   4. iOS reads its keychain-cached deviceId; backend already mapped tokens.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { db } from '../db/pool.js';
import { env } from '../lib/env.js';
import {
  authURL, exchangeCode, refresh, userSettings, scrobble,
} from '../lib/trakt.js';

export const traktRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/trakt/status', async (req) => {
    const r = await db.query<{ username: string | null; expires_at: Date }>(
      `SELECT username, expires_at FROM trakt_tokens WHERE device_id = $1`,
      [req.deviceId]
    );
    const row = r.rows[0];
    return {
      connected: !!row,
      username: row?.username ?? null,
      expiresAt: row?.expires_at ?? null,
    };
  });

  app.post('/me/trakt/start', async (req, reply) => {
    if (!env.TRAKT_CLIENT_ID) {
      reply.code(503);
      return { error: 'Trakt is not configured on this server' };
    }
    const nonce = randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO trakt_pending (nonce, device_id) VALUES ($1, $2)`,
      [nonce, req.deviceId]
    );
    return { authorizeURL: authURL(nonce) };
  });

  // Trakt redirects browser here — exchange code, store tokens, send the
  // user back into the iOS app via the custom URL scheme.
  app.get('/me/trakt/callback', async (req, reply) => {
    const q = z.object({
      code: z.string().min(1),
      state: z.string().min(1),
    }).parse(req.query);

    const pending = await db.query<{ device_id: string }>(
      `SELECT device_id FROM trakt_pending WHERE nonce = $1`,
      [q.state]
    );
    if (pending.rowCount === 0) {
      reply.code(400);
      return { error: 'unknown nonce' };
    }
    const deviceId = pending.rows[0]!.device_id;
    await db.query(`DELETE FROM trakt_pending WHERE nonce = $1`, [q.state]);

    try {
      const tokens = await exchangeCode(q.code);
      const me = await userSettings(tokens.accessToken);
      await db.query(
        `INSERT INTO trakt_tokens (device_id, access_token, refresh_token, expires_at, username)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE
           SET access_token = EXCLUDED.access_token,
               refresh_token = EXCLUDED.refresh_token,
               expires_at = EXCLUDED.expires_at,
               username = EXCLUDED.username,
               updated_at = NOW()`,
        [deviceId, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, me?.username ?? null]
      );

      reply.redirect(env.TRAKT_APP_REDIRECT + `?ok=1&user=${encodeURIComponent(me?.username ?? '')}`, 302);
      return;
    } catch (e) {
      reply.redirect(env.TRAKT_APP_REDIRECT + `?ok=0&error=${encodeURIComponent((e as Error).message)}`, 302);
      return;
    }
  });

  app.delete('/me/trakt', async (req) => {
    await db.query(`DELETE FROM trakt_tokens WHERE device_id = $1`, [req.deviceId]);
    return { ok: true };
  });

  // Scrobble — proxy from iOS so the secret stays server-side.
  app.post('/me/trakt/scrobble', async (req, reply) => {
    const body = z.object({
      action: z.enum(['start', 'pause', 'stop']),
      type: z.enum(['movie', 'episode']),
      imdbID: z.string().optional(),
      tmdbID: z.number().int().optional(),
      progress: z.number().min(0).max(100),
    }).parse(req.body);

    const r = await db.query<{ access_token: string; refresh_token: string; expires_at: Date }>(
      `SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE device_id = $1`,
      [req.deviceId]
    );
    const row = r.rows[0];
    if (!row) { reply.code(400); return { error: 'Trakt not connected' }; }

    let access = row.access_token;
    if (row.expires_at.getTime() < Date.now() + 5 * 60 * 1000) {
      // Refresh proactively if within 5 min of expiry.
      try {
        const fresh = await refresh(row.refresh_token);
        access = fresh.accessToken;
        await db.query(
          `UPDATE trakt_tokens
              SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = NOW()
            WHERE device_id = $4`,
          [fresh.accessToken, fresh.refreshToken, fresh.expiresAt, req.deviceId]
        );
      } catch (e) {
        reply.code(401);
        return { error: 'Trakt token refresh failed', details: (e as Error).message };
      }
    }

    try {
      await scrobble(access, body.action, {
        imdbID: body.imdbID, tmdbID: body.tmdbID,
        type: body.type, progress: body.progress,
      });
      return { ok: true };
    } catch (e) {
      reply.code(502);
      return { error: 'scrobble failed', details: (e as Error).message };
    }
  });
};
