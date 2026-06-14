-- 0006_sync_rev: foundation for server-authoritative `rev` (sync L2).
--
-- Six new columns:
--   workspaces.sync_rev INTEGER NOT NULL DEFAULT 0
--                                 Per-workspace monotonic version counter.
--                                 The sync txn bumps it exactly once per sync
--                                 (UPDATE ... sync_rev = sync_rev + 1) in L2.2;
--                                 every row it writes is stamped with the new
--                                 value. A per-workspace total order → also
--                                 enables L3's "pull rev > N".
--   nodes.rev    INTEGER          Per-row version: the workspaces.sync_rev at
--   edges.rev    INTEGER          which a sync txn last wrote this row.
--   messages.rev INTEGER          NULLABLE ON PURPOSE — NULL means "predates
--   trees.rev    INTEGER          versioning / no claim". The L2.2 conflict
--   contexts.rev INTEGER          guard treats a stored rev of NULL as
--                                 unconditional-accept, so the first sync after
--                                 an upgrade can never raise a spurious
--                                 conflict on rows that existed before this
--                                 migration. (Hence INTEGER, not
--                                 INTEGER NOT NULL DEFAULT 0.)
--
-- L2.1 is purely additive: these columns get WRITTEN (leaf save* gains an
-- optional `rev` param + COALESCE stamp) but NOTHING reads or guards on them
-- yet — that wiring lands in L2.2. No behavior change.
--
-- Idempotent: the runner (services/migrate.ts) applies *.sql lexicographically
-- through the `schema_migrations` ledger and swallows duplicate-column /
-- already-exists errors, so a re-run (or a DB that already received these
-- columns via a different code path) records the migration as applied without
-- failing. SQLite's ALTER TABLE ADD COLUMN has no IF NOT EXISTS form, so this
-- benign-error swallow is what makes the file a safe no-op on re-run.

ALTER TABLE workspaces ADD COLUMN sync_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes      ADD COLUMN rev INTEGER;
ALTER TABLE edges      ADD COLUMN rev INTEGER;
ALTER TABLE messages   ADD COLUMN rev INTEGER;
ALTER TABLE trees      ADD COLUMN rev INTEGER;
ALTER TABLE contexts   ADD COLUMN rev INTEGER;
