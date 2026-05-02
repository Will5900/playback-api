//
// /watch — append-only watch event log + saved-titles CRUD. Used for resume
// position sync and the "Continue watching" row.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';

const Event = z.object({
  profileId: z.string().uuid().optional(),
  titleId: z.string().min(1),
  kind: z.enum(['start', 'progress', 'finish']),
  positionSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const watchRoutes: FastifyPluginAsync = async (app) => {
  app.post('/watch/events', async (req, reply) => {
    const body = Event.parse(req.body);
    await db.query(
      `INSERT INTO watch_events (device_id, profile_id, title_id, kind,
                                 position_sec, duration_sec, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        req.deviceId,
        body.profileId ?? null,
        body.titleId,
        body.kind,
        body.positionSec ?? null,
        body.durationSec ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
      ]
    );
    reply.code(201);
    return { ok: true };
  });

  // Resume positions: latest progress per title_id for this device/profile.
  app.get('/watch/resume', async (req) => {
    const q = z.object({ profileId: z.string().uuid().optional() }).parse(req.query);
    const r = await db.query(
      `SELECT DISTINCT ON (title_id)
              title_id AS "titleId",
              position_sec AS "positionSec",
              duration_sec AS "durationSec",
              occurred_at AS "occurredAt"
         FROM watch_events
        WHERE device_id = $1
          AND ($2::uuid IS NULL OR profile_id = $2)
          AND kind IN ('progress', 'finish')
        ORDER BY title_id, occurred_at DESC
        LIMIT 50`,
      [req.deviceId, q.profileId ?? null]
    );
    return { items: r.rows };
  });

  // Saved library
  app.get('/watch/saved', async (req) => {
    const q = z.object({ profileId: z.string().uuid() }).parse(req.query);
    const r = await db.query(
      `SELECT title_id AS "titleId", name, poster_url AS "posterURL",
              year, genre, match_score AS "matchScore",
              added_at AS "addedAt"
         FROM saved_titles
        WHERE device_id = $1 AND profile_id = $2
        ORDER BY added_at DESC`,
      [req.deviceId, q.profileId]
    );
    return { items: r.rows };
  });

  app.put('/watch/saved/:titleId', async (req) => {
    const params = z.object({ titleId: z.string().min(1) }).parse(req.params);
    const body = z.object({
      profileId: z.string().uuid(),
      name: z.string().min(1),
      posterURL: z.string().url().optional(),
      year: z.number().int().optional(),
      genre: z.string().optional(),
      matchScore: z.number().optional(),
    }).parse(req.body);
    await db.query(
      `INSERT INTO saved_titles (device_id, profile_id, title_id, name,
                                 poster_url, year, genre, match_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (profile_id, title_id) DO UPDATE
         SET name = EXCLUDED.name,
             poster_url = EXCLUDED.poster_url,
             year = EXCLUDED.year,
             genre = EXCLUDED.genre,
             match_score = EXCLUDED.match_score`,
      [req.deviceId, body.profileId, params.titleId, body.name,
       body.posterURL ?? null, body.year ?? null, body.genre ?? null,
       body.matchScore ?? null]
    );
    return { ok: true };
  });

  app.delete('/watch/saved/:titleId', async (req) => {
    const params = z.object({ titleId: z.string().min(1) }).parse(req.params);
    const q = z.object({ profileId: z.string().uuid() }).parse(req.query);
    await db.query(
      'DELETE FROM saved_titles WHERE device_id = $1 AND profile_id = $2 AND title_id = $3',
      [req.deviceId, q.profileId, params.titleId]
    );
    return { ok: true };
  });
};
