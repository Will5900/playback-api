//
// /_debug — operator-only inspection endpoints. Useful when debugging from a
// phone with no access to server logs. Authentication is the same x-install-token
// that protects everything else, so only the device that owns the token can
// see its own request history.
//

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { recentReqs } from '../lib/reqlog.js';

export const debugRoutes: FastifyPluginAsync = async (app) => {
  // Last N requests this device has made (or all, if ?all=1).
  app.get('/_debug/recent', async (req) => {
    const q = z.object({
      all: z.coerce.boolean().optional(),
      status: z.coerce.number().int().optional(),
      contains: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    return {
      deviceId: req.deviceId,
      requests: recentReqs({
        deviceId: q.all ? undefined : req.deviceId,
        status: q.status,
        pathContains: q.contains,
        limit: q.limit,
      }),
    };
  });

  // Snapshot of this device's addon state — manifest urls, enabled flag,
  // and the first few catalog entries from each. Lets you confirm an addon
  // really did install and what catalogs the server thinks it advertises.
  app.get('/_debug/addons', async (req) => {
    const r = await db.query(
      `SELECT manifest_url AS "manifestUrl", name, version, enabled,
              resources, types, catalogs,
              added_at AS "addedAt", last_fetched_at AS "lastFetchedAt"
         FROM addons
        WHERE device_id = $1
        ORDER BY added_at DESC`,
      [req.deviceId]
    );
    return {
      deviceId: req.deviceId,
      count: r.rowCount,
      addons: r.rows,
    };
  });
};
