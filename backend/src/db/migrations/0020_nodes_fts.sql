-- FTS5 virtual table for node titles, enabling title-based search.
-- Mirrors the messages_fts pattern: content-sync table with triggers.
-- The tokenize='unicode61' ensures proper CJK character handling.

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  title,
  content=nodes,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- Backfill existing node titles into the FTS index.
INSERT INTO nodes_fts(rowid, title)
  SELECT rowid, COALESCE(title, '') FROM nodes WHERE title IS NOT NULL AND TRIM(title) != '';

-- Keep FTS in sync when nodes are inserted, deleted, or updated.
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes
WHEN new.title IS NOT NULL AND TRIM(new.title) != ''
BEGIN
  INSERT INTO nodes_fts(rowid, title) VALUES (new.rowid, new.title);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.rowid, COALESCE(old.title, ''));
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE OF title ON nodes BEGIN
  -- Delete old entry (if it existed).
  INSERT INTO nodes_fts(nodes_fts, rowid, title) VALUES('delete', old.rowid, COALESCE(old.title, ''));
  -- Insert new entry (if non-empty).
  INSERT INTO nodes_fts(rowid, title)
    SELECT new.rowid, new.title
    WHERE new.title IS NOT NULL AND TRIM(new.title) != '';
END;
