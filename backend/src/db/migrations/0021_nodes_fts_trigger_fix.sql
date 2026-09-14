-- Fix the nodes_fts triggers introduced by 0020_nodes_fts.sql.
--
-- nodes_fts is an FTS5 *external content* table (content=nodes). For such a
-- table the special 'delete' command must be given column values that match
-- what is currently stored in the index for that rowid; FTS5 uses them to
-- subtract the right terms. 0020 broke that invariant two ways:
--
--   1. its AFTER INSERT trigger indexed a row only WHEN the title was
--      non-empty, so untitled nodes were never indexed at all; but
--   2. its AFTER UPDATE / AFTER DELETE triggers issued 'delete'
--      UNCONDITIONALLY, and with COALESCE(old.title,'') rather than the
--      stored value.
--
-- So setting a title on a previously-untitled node asked FTS5 to delete an
-- entry that was never inserted. Measured consequences:
--
--   * empty index (a fresh database - every test database and every new
--     user database): the UPDATE raises SQLITE_CORRUPT_VTAB
--     ("database disk image is malformed"). Because writeTurnNodeProjection
--     runs NODE_SQL.setTitleIfEmpty inside coreFinalizeTurn's transaction,
--     the whole turn rolls back and the assistant message is persisted
--     empty.
--   * populated index (an established database): the UPDATE silently
--     succeeds but leaves the index inconsistent - FTS5's
--     'integrity-check' fails afterwards.
--
-- Either way the index is corrupted, so this migration also rebuilds it.
--
-- The fix keeps one simple invariant: every nodes row has exactly one
-- nodes_fts entry, and every value handed to FTS5 is passed through
-- verbatim (no COALESCE, no WHEN filter), so a 'delete' always matches what
-- was indexed. An untitled node indexes as NULL, which contributes no tokens
-- and therefore never matches a query - title search behaviour is unchanged.

DROP TRIGGER IF EXISTS nodes_fts_ai;
DROP TRIGGER IF EXISTS nodes_fts_ad;
DROP TRIGGER IF EXISTS nodes_fts_au;

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title) VALUES (new.rowid, new.title);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.rowid, old.title);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE OF title ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.rowid, old.title);
  INSERT INTO nodes_fts(rowid, title) VALUES (new.rowid, new.title);
END;

-- Any database that ran 0020 may already hold an inconsistent index, and the
-- new triggers assume every row is indexed. Rebuild from the content table so
-- both assumptions hold from here on.
INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');
