-- Moving a thread to another workspace left the source workspace's
-- active_tree_id pointing at the moved tree, which now belongs elsewhere.
-- Every later graph command in that workspace then failed with
-- active_tree_workspace_mismatch. moveTreeToWorkspace now repoints it; this
-- repairs workspaces already left dangling, with the same fallback: the most
-- recently active unarchived tree with a live root, else none.
UPDATE workspaces SET active_tree_id = (
  SELECT t.id FROM trees t JOIN nodes n ON n.id = t.root_node_id
  WHERE t.workspace_id = workspaces.id AND t.archived_at IS NULL
    AND n.deleted_at IS NULL AND n.purged_at IS NULL
  ORDER BY t.last_active_at DESC LIMIT 1
)
WHERE active_tree_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM trees t WHERE t.id = workspaces.active_tree_id AND t.workspace_id = workspaces.id
  );
