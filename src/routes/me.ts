//
// /me — device introspection + profile CRUD.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';

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

  app.put('/me/debrid/:provider', async (req) => {
    const params = z.object({ provider: z.enum(['RD', 'AD', 'PM']) }).parse(req.params);
    const body = z.object({ token: z.string().min(8).max(400) }).parse(req.body);
    await db.query(
      `INSERT INTO debrid_tokens (device_id, provider, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id, provider) DO UPDATE SET token = EXCLUDED.token, added_at = NOW()`,
      [req.deviceId, params.provider, body.token]
    );
    return { ok: true };
  });

  app.delete('/me/debrid/:provider', async (req) => {
    const params = z.object({ provider: z.enum(['RD', 'AD', 'PM']) }).parse(req.params);
    await db.query(
      'DELETE FROM debrid_tokens WHERE device_id = $1 AND provider = $2',
      [req.deviceId, params.provider]
    );
    return { ok: true };
  });
};
