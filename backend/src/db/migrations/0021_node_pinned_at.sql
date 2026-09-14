-- 0021_node_pinned_at: add pinned_at column to nodes table.
--
-- Node-level pin: a pinned branch node floats to the top of its sibling group
-- in the sidebar. Mirrors trees.pinned_at (V14) / workspaces.pinned_at (0007)
-- / contexts.pinned_at (0008). NULL = not pinned; otherwise Unix ms when the
-- user pinned it (used for pinned-first ordering, most recent pin first).

ALTER TABLE nodes ADD COLUMN pinned_at INTEGER;
