//
// /me — device introspection + profile CRUD.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { rdUserInfo, rdValidateToken } from '../lib/debrid.js';

const NewProfile = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(40),
  region: z.string().length(2).optional(),
  ageRating: z.string().max(8).optional(),
  isKids: z.boolean().optional(),
});

const UpdateProfile = NewProfile.partial().extend({ id: z.string().uuid() });

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    const profiles = await db.query(
      `SELECT id, name, region, age_rating AS "ageRating",
              is_kids AS "isKids", taste_confidence AS "tasteConfidence",
              created_at AS "createdAt"
         FROM profiles
        WHERE device_id = $1
        ORDER BY created_at`,
      [req.deviceId]
    );
    return { deviceId: req.deviceId, profiles: profiles.rows };
  });

  app.post('/me/profiles', async (req, reply) => {
    const body = NewProfile.parse(req.body);
    await db.query(
      `INSERT INTO profiles (id, device_id, name, region, age_rating, is_kids)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             region = EXCLUDED.region,
             age_rating = EXCLUDED.age_rating,
             is_kids = EXCLUDED.is_kids,
             updated_at = NOW()`,
      [body.id, req.deviceId, body.name, body.region ?? 'GB', body.ageRating ?? 'all', body.isKids ?? false]
    );
    reply.code(201);
    return { id: body.id };
  });

  app.patch('/me/profiles/:id', async (req) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateProfile.parse({ ...(req.body as object), id: params.id });
    await db.query(
      `UPDATE profiles
          SET name       = COALESCE($1, name),
              region     = COALESCE($2, region),
              age_rating = COALESCE($3, age_rating),
              is_kids    = COALESCE($4, is_kids),
              updated_at = NOW()
        WHERE id = $5 AND device_id = $6`,
      [body.name, body.region, body.ageRating, body.isKids, body.id, req.deviceId]
    );
    return { ok: true };
  });

  app.delete('/me/profiles/:id', async (req) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query(
      'DELETE FROM profiles WHERE id = $1 AND device_id = $2',
      [params.id, req.deviceId]
    );
    return { ok: true };
  });

  // Debrid token management
  app.get('/me/debrid', async (req) => {
    const r = await db.query(
      `SELECT provider, added_at AS "addedAt"
         FROM debrid_tokens
        WHERE device_id = $1`,
      [req.deviceId]
    );
    return { tokens: r.rows };
  });

  app.put('/me/debrid/:provider', async (req, reply) => {
    const params = z.object({ provider: z.enum(['RD', 'AD', 'PM']) }).parse(req.params);
    const body = z.object({
      token: z.string().min(8).max(400),
      // Allow callers to opt out of validation (e.g. when offline or for AD/PM).
      skipValidation: z.boolean().optional(),
    }).parse(req.body);

    let userInfo: Awaited<ReturnType<typeof rdValidateToken>> | null = null;
    if (params.provider === 'RD' && !body.skipValidation) {
      try {
        userInfo = await rdValidateToken(body.token);
      } catch (e) {
        reply.code(400);
        return { error: 'token rejected by Real-Debrid', details: (e as Error).message };
      }
    }

    await db.query(
      `INSERT INTO debrid_tokens (device_id, provider, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id, provider) DO UPDATE SET token = EXCLUDED.token, added_at = NOW()`,
      [req.deviceId, params.provider, body.token]
    );
    return userInfo
      ? { ok: true, user: { username: userInfo.username, expiration: userInfo.expiration, type: userInfo.type } }
      : { ok: true };
  });

  app.delete('/me/debrid/:provider', async (req) => {
    const params = z.object({ provider: z.enum(['RD', 'AD', 'PM']) }).parse(req.params);
    await db.query(
      'DELETE FROM debrid_tokens WHERE device_id = $1 AND provider = $2',
      [req.deviceId, params.provider]
    );
    return { ok: true };
  });

  // Live token-health check. iOS shows "Real-Debrid premium until <date>"
  // or surfaces an expired/invalid token to the user.
  app.get('/me/debrid/:provider/test', async (req, reply) => {
    const params = z.object({ provider: z.enum(['RD', 'AD', 'PM']) }).parse(req.params);
    const tok = await db.query<{ token: string }>(
      'SELECT token FROM debrid_tokens WHERE device_id = $1 AND provider = $2',
      [req.deviceId, params.provider]
    );
    const token = tok.rows[0]?.token;
    if (!token) {
      reply.code(404);
      return { ok: false, error: 'no token configured' };
    }
    if (params.provider !== 'RD') {
      reply.code(501);
      return { ok: false, error: `${params.provider} test not yet implemented` };
    }
    try {
      const user = await rdUserInfo(token);
      if (!user) {
        reply.code(401);
        return { ok: false, error: 'token rejected by Real-Debrid' };
      }
      return {
        ok: true,
        provider: 'RD',
        username: user.username,
        type: user.type,
        premiumSecondsRemaining: user.premium,
        expiration: user.expiration,
      };
    } catch (e) {
      reply.code(502);
      return { ok: false, error: 'Real-Debrid unreachable', details: (e as Error).message };
    }
  });
};
