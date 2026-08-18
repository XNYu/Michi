-- Add multi-folder support to workspaces.
-- folders is a JSON array of FolderEntry objects. When non-null and non-empty,
-- folders[0].path is the canonical cwd. The legacy `cwd` column is preserved
-- for backward compatibility; new code reads from `folders`.

ALTER TABLE workspaces ADD COLUMN folders TEXT;

-- Migrate existing cwd values into the folders array.
-- hex(randomblob(8)) produces a 16-char hex string as a stable unique id.
UPDATE workspaces
  SET folders = json_array(
    json_object(
      'id', hex(randomblob(8)),
      'path', cwd,
      'addedAt', created_at
    )
  )
  WHERE cwd IS NOT NULL AND cwd != ''
    AND (folders IS NULL OR folders = '[]' OR folders = '');
