//
// /watch — append-only watch event log + saved-titles CRUD. Powers resume
// position sync, "Continue watching", and the library.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { normalizeArtwork } from '../lib/artwork.js';

const Event = z.object({
  profileId: z.string().uuid().optional(),
  titleId: z.string().min(1),
  kind: z.enum(['start', 'progress', 'finish']),
  positionSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive().optional(),
  // Free-form bag the iOS app uses to stash name/poster/type/season/episode
  // so /watch/resume can reconstruct the continue-watching row in one call.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// A title is "effectively finished" if its last position is within ~2.5%
// of duration. Stops "credits-rolled" movies from cluttering continue.
const FINISHED_THRESHOLD = 0.975;

export const watchRoutes: FastifyPluginAsync = async (app) => {
  app.post('/watch/events', async (req, reply) => {
    const body = Event.parse(req.body);
    await insertEvent(req.deviceId, body);
    reply.code(201);
    return { ok: true };
  });

  // Batch ingest for offline catch-up. iOS buffers events while the network
  // is down and POSTs the queue in one shot when it comes back.
  app.post('/watch/events/batch', async (req, reply) => {
    const body = z.object({
      events: z.array(Event).min(1).max(500),
    }).parse(req.body);
    await db.tx(async (c) => {
      for (const e of body.events) {
        await c.query(
          `INSERT INTO watch_events (device_id, profile_id, title_id, kind,
                                     position_sec, duration_sec, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            req.deviceId,
            e.profileId ?? null,
            e.titleId,
            e.kind,
            e.positionSec ?? null,
            e.durationSec ?? null,
            e.metadata ? JSON.stringify(e.metadata) : null,
          ]
        );
      }
    });
    reply.code(201);
    return { ok: true, accepted: body.events.length };
  });

  // Continue-watching feed.
  // - Drops titles whose latest event is `finish` or whose last position is
  //   within FINISHED_THRESHOLD of duration.
  // - Surfaces metadata from the latest event so iOS doesn't need a second call.
  // - When `scope=profile`, includes events from any device for the profile
  //   (cross-device sync). Default `scope=device` preserves old behaviour.
  app.get('/watch/resume', async (req) => {
    const q = z.object({
      profileId: z.string().uuid().optional(),
      scope: z.enum(['device', 'profile']).default('device'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

    const useProfileScope = q.scope === 'profile' && !!q.profileId;
    const r = await db.query<{
      titleId: string;
      positionSec: number | null;
      durationSec: number | null;
      kind: string;
      occurredAt: Date;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT DISTINCT ON (title_id)
              title_id     AS "titleId",
              position_sec AS "positionSec",
              duration_sec AS "durationSec",
              kind,
              occurred_at  AS "occurredAt",
              metadata
         FROM watch_events
        WHERE ($1::uuid IS NULL OR device_id = $1)
          AND ($2::uuid IS NULL OR profile_id = $2)
          AND kind IN ('start', 'progress', 'finish')
        ORDER BY title_id, occurred_at DESC`,
      [
        useProfileScope ? null : req.deviceId,
        q.profileId ?? null,
      ]
    );

    const filtered = r.rows
      .filter((row) => {
        if (row.kind === 'finish') return false;
        if (row.positionSec != null && row.durationSec && row.durationSec > 0) {
          if (row.positionSec / row.durationSec >= FINISHED_THRESHOLD) return false;
        }
        return true;
      })
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, q.limit);

    const items = await Promise.all(filtered.map(async (row) => {
      const art = await normalizeArtwork({
        titleId: row.titleId,
        posterURL:  pickString(row.metadata, 'posterURL', 'poster', 'poster_url'),
        backdropURL: pickString(row.metadata, 'backdropURL', 'backdrop', 'background', 'backdrop_url'),
      });
      return {
        titleId: row.titleId,
        positionSec: row.positionSec,
        durationSec: row.durationSec,
        occurredAt: row.occurredAt,
        // Surface common metadata fields at the top level for iOS Codable
        // convenience while preserving the full bag under `metadata`.
        name:    pickString(row.metadata, 'name'),
        type:    pickString(row.metadata, 'type'),
        season:  pickNumber(row.metadata, 'season'),
        episode: pickNumber(row.metadata, 'episode'),
        ...art,
        metadata: row.metadata ?? undefined,
      };
    }));

    return { items };
  });

  // Reverse-chrono list of completed titles (last 200), optionally per profile.
  app.get('/watch/history', async (req) => {
    const q = z.object({
      profileId: z.string().uuid().optional(),
      scope: z.enum(['device', 'profile']).default('device'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);

    const useProfileScope = q.scope === 'profile' && !!q.profileId;
    const r = await db.query<{
      titleId: string;
      finishedAt: Date;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT DISTINCT ON (title_id)
              title_id    AS "titleId",
              occurred_at AS "finishedAt",
              metadata
         FROM watch_events
        WHERE ($1::uuid IS NULL OR device_id = $1)
          AND ($2::uuid IS NULL OR profile_id = $2)
          AND kind = 'finish'
        ORDER BY title_id, occurred_at DESC
        LIMIT $3`,
      [
        useProfileScope ? null : req.deviceId,
        q.profileId ?? null,
        q.limit,
      ]
    );

    const sorted = r.rows.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
    const items = await Promise.all(sorted.map(async (row) => {
      const art = await normalizeArtwork({
        titleId: row.titleId,
        posterURL:  pickString(row.metadata, 'posterURL', 'poster', 'poster_url'),
        backdropURL: pickString(row.metadata, 'backdropURL', 'backdrop', 'background', 'backdrop_url'),
      });
      return {
        titleId: row.titleId,
        finishedAt: row.finishedAt,
        name: pickString(row.metadata, 'name'),
        type: pickString(row.metadata, 'type'),
        ...art,
      };
    }));
    return { items };
  });

  // Saved library
  app.get('/watch/saved', async (req) => {
    const q = z.object({ profileId: z.string().uuid() }).parse(req.query);
    const r = await db.query<SavedRow>(
      `SELECT title_id AS "titleId", name, poster_url AS "posterURL",
              year, genre, match_score AS "matchScore",
              added_at AS "addedAt"
         FROM saved_titles
        WHERE device_id = $1 AND profile_id = $2
        ORDER BY added_at DESC`,
      [req.deviceId, q.profileId]
    );
    const items = await Promise.all(r.rows.map(enrichSavedRow));
    return { items };
  });

  // Single-title check — lets iOS render the heart icon without pulling the
  // whole library on every meta page.
  app.get('/watch/saved/:titleId', async (req, reply) => {
    const params = z.object({ titleId: z.string().min(1) }).parse(req.params);
    const q = z.object({ profileId: z.string().uuid() }).parse(req.query);
    const r = await db.query<SavedRow>(
      `SELECT title_id AS "titleId", name, poster_url AS "posterURL",
              year, genre, match_score AS "matchScore",
              added_at AS "addedAt"
         FROM saved_titles
        WHERE device_id = $1 AND profile_id = $2 AND title_id = $3`,
      [req.deviceId, q.profileId, params.titleId]
    );
    if (r.rowCount === 0) {
      reply.code(404);
      return { saved: false };
    }
    return { saved: true, item: await enrichSavedRow(r.rows[0]!) };
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

interface SavedRow {
  titleId: string;
  name: string;
  posterURL: string | null;
  year: number | null;
  genre: string | null;
  matchScore: number | null;
  addedAt: Date;
}

async function enrichSavedRow(row: SavedRow) {
  const art = await normalizeArtwork({ titleId: row.titleId, posterURL: row.posterURL });
  return {
    titleId: row.titleId,
    name: row.name,
    year: row.year,
    genre: row.genre,
    matchScore: row.matchScore,
    addedAt: row.addedAt,
    ...art,
  };
}

async function insertEvent(deviceId: string, e: z.infer<typeof Event>) {
  await db.query(
    `INSERT INTO watch_events (device_id, profile_id, title_id, kind,
                               position_sec, duration_sec, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      deviceId,
      e.profileId ?? null,
      e.titleId,
      e.kind,
      e.positionSec ?? null,
      e.durationSec ?? null,
      e.metadata ? JSON.stringify(e.metadata) : null,
    ]
  );
}

function pickString(bag: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!bag) return undefined;
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(bag: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!bag) return undefined;
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}
