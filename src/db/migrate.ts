//
// Tiny migration runner. Reads numeric SQL files from /migrations in order,
// executes any not yet applied, records them in schema_migrations.
//
// Usage: tsx src/db/migrate.ts up | down
//

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { db } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function applied(): Promise<Set<string>> {
  const r = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(r.rows.map(r => r.version));
}

async function up() {
  await ensureTable();
  const done = await applied();
  const files = (await readdir(migrationsDir))
    .filter(f => /^\d+_.+\.up\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = f.replace(/\.up\.sql$/, '');
    if (done.has(version)) continue;
    const sql = await readFile(join(migrationsDir, f), 'utf8');
    console.log('[migrate] applying', version);
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
  }
  console.log('[migrate] up to date');
}

async function down() {
  await ensureTable();
  const done = await applied();
  if (done.size === 0) {
    console.log('[migrate] nothing to roll back');
    return;
  }
  const last = [...done].sort().pop()!;
  const f = `${last}.down.sql`;
  const sql = await readFile(join(migrationsDir, f), 'utf8');
  console.log('[migrate] rolling back', last);
  await db.tx(async (c) => {
    await c.query(sql);
    await c.query('DELETE FROM schema_migrations WHERE version = $1', [last]);
  });
}

const cmd = process.argv[2] ?? 'up';
const fn = cmd === 'down' ? down : up;
fn()
  .then(() => db.end().then(() => process.exit(0)))
  .catch((e) => { console.error(e); db.end().then(() => process.exit(1)); });
