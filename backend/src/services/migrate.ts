import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * File-based SQL migration runner using node:sqlite (DatabaseSync).
 *
 * - Creates a ledger table (default: schema_migrations) if absent.
 * - Reads *.sql files from `dir`, sorted lexicographically.
 * - Skips files whose basename (without .sql) is already in the ledger.
 * - Runs each new migration inside a transaction, statement by statement;
 *   throws on the first non-benign failure (see isBenign).
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
      // One statement at a time, so a benign error skips only the statement
      // that raised it; the rest of the file still runs.
      for (const statement of splitStatements(sql)) {
        try {
          db.exec(statement);
        } catch (err) {
          if (!isBenign(statement, (err as Error).message)) throw err;
        }
      }
      db.prepare(
        `INSERT INTO ${ledgerTable} (version, applied_at) VALUES (?, ?)`
      ).run(version, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration "${version}" failed: ${(err as Error).message}`);
    }
  }
}

/**
 * SQLite's `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS form, so an
 * idempotent "ensure column" migration can fail on a DB that received the same
 * column from a previous deployment via a different code path (e.g. an inline
 * `migrateVN` we have since retired in favour of file migrations). A duplicate
 * column on ADD COLUMN, or an existing object on CREATE, means the schema is
 * already there: skip that statement. Anything else is still a hard failure.
 */
function isBenign(statement: string, message: string): boolean {
  if (/duplicate column name/i.test(message)) {
    return /^ALTER\s+TABLE\s+\S+\s+ADD\b/i.test(statement);
  }
  if (/already exists/i.test(message)) return /^CREATE\b/i.test(statement);
  return false;
}

// Token classes and state machine of SQLite's sqlite3_complete() (complete.c):
// a `;` ends a statement unless it is inside a string, quoted identifier,
// comment, or a CREATE TRIGGER ... BEGIN ... END body.
const SEMI = 0, WS = 1, OTHER = 2, EXPLAIN = 3, CREATE = 4, TEMP = 5, TRIGGER = 6, END = 7;
const START = 1;
const TRANSITIONS: number[][] = [
  /*              SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END */
  /* 0 INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1 START   */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2 NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4 CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6 SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7 END     */ [1, 7, 5, 5, 5, 5, 5, 5],
];
const KEYWORDS: Record<string, number> = {
  create: CREATE, trigger: TRIGGER, temp: TEMP, temporary: TEMP, end: END, explain: EXPLAIN,
};

function isIdChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;
}

/** Split a migration file into statements, without leading comments/whitespace. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let state = 0;
  let start = -1; // offset of the current statement's first token
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    let next = i + 1;
    let token = OTHER;
    if (c === ';') {
      token = SEMI;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      token = WS;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      next = close < 0 ? sql.length : close + 2;
      token = WS;
    } else if (c === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i + 2);
      next = newline < 0 ? sql.length : newline + 1;
      token = WS;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = sql.indexOf(c === '[' ? ']' : c, i + 1);
      next = close < 0 ? sql.length : close + 1;
    } else if (isIdChar(c)) {
      while (next < sql.length && isIdChar(sql[next])) next++;
      token = KEYWORDS[sql.slice(i, next).toLowerCase()] ?? OTHER;
    }
    if (start < 0 && token !== WS && token !== SEMI) start = i;
    state = TRANSITIONS[state][token];
    i = next;
    if (token === SEMI && state === START) {
      if (start >= 0) statements.push(sql.slice(start, i));
      start = -1;
    }
  }
  if (start >= 0) statements.push(sql.slice(start));
  return statements;
}
