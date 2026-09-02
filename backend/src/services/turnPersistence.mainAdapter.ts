/**
 * Main-thread DbPrimitives adapter.
 *
 * Wraps the main-thread `DatabaseSync` connection (via `db.ts` helpers)
 * into the `DbPrimitives` interface consumed by `turnPersistence.core.ts`.
 *
 * Key responsibility: coerce `bigint` → `number` on `run().changes` so
 * the core never sees `node:sqlite`'s bigint quirk.
 */

import { prepareCached, runInTransaction } from './db';
import type { SQLInputValue } from 'node:sqlite';
import type { DbPrimitives } from './turnPersistence.core';

export const mainThreadDb: DbPrimitives = {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return prepareCached(sql).get(...(params as SQLInputValue[])) as T | undefined;
  },

  run(sql: string, ...params: unknown[]): { changes: number } {
    const result = prepareCached(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes) };
  },

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return prepareCached(sql).all(...(params as SQLInputValue[])) as unknown as T[];
  },

  runNamed(sql: string, params: Record<string, unknown>): void {
    prepareCached(sql).run(params as Record<string, SQLInputValue>);
  },

  runInTransaction,
};
