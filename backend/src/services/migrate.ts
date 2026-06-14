import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * File-based SQL migration runner using node:sqlite (DatabaseSync).
 *
 * - Creates a ledger table (default: schema_migrations) if absent.
 * - Reads *.sql files from `dir`, sorted lexicographically.
 * - Skips files whose basename (without .sql) is already in the ledger.
 * - Runs each new migration inside a transaction; throws on first failure.
 * - Does NOT depend on drizzle at runtime — pure node:fs + node:sqlite.
 */
export function runMigrations(
  db: DatabaseSync,
  dir: string,
  ledgerTable = 'schema_migrations'
): void {
  // Create ledger table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ledgerTable} (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  // Read migration files sorted lexicographically. Throw on missing dir —
  // a silent no-op here once shipped a half-migrated prod (P1.5 table absent,
  // P1.3 column absent) because esbuild didn't copy *.sql into dist/. Better
  // a loud boot failure than a quietly broken cloud install.
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Collect already-applied versions
  const applied = new Set(
    (db.prepare(`SELECT version FROM ${ledgerTable}`).all() as Array<{ version: string }>)
      .map((r) => r.version)
  );

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare(
        `INSERT INTO ${ledgerTable} (version, applied_at) VALUES (?, ?)`
      ).run(version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      const msg = (err as Error).message;
      // SQLite's `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS form,
      // so an idempotent "ensure column" migration can fail on a DB that
      // received the same column from a previous deployment via a
      // different code path (e.g. an inline `migrateVN` we have since
      // retired in favour of file migrations). Treat duplicate-column /
      // duplicate-table errors as success — record the migration as
      // applied so we don't keep retrying, but don't lose the schema we
      // already have. Anything else is still a hard failure.
      const benign = /duplicate column name|already exists/i.test(msg);
      if (!benign) {
        throw new Error(`Migration "${version}" failed: ${msg}`);
      }
      db.prepare(
        `INSERT OR IGNORE INTO ${ledgerTable} (version, applied_at) VALUES (?, ?)`
      ).run(version, Date.now());
    }
  }
}
