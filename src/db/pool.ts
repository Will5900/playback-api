//
// Single shared pg Pool. Use db.query for one-off statements; db.tx for
// transactions.
//

import pg from 'pg';
import { env } from '../lib/env.js';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = {
  query: pool.query.bind(pool),
  /** Run a callback inside a single client transaction. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
  end: pool.end.bind(pool),
};
