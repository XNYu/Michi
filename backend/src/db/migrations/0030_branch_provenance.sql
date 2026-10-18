-- 0030_branch_provenance: durable provenance for a branch that is materialized
-- as an independent thread (Extract as new thread) and for the strategy a
-- branch session actually used.
--
-- nodes.inherited_message_count is the exact prefix length copied from the
-- parent chain; messages with seq < this value are inherited, not authored by
-- the extracted thread. nodes.forked_from_node_id / fork_boundary_message_id
-- keep the source and cut without depending on the (now deleted) branch edge.
--
-- edges.fork_boundary_message_id is immutable fork provenance: unlike
-- anchor_message_id it is never cleared when the parent message is trimmed.
-- edges.fork_kind records how the child session was actually seeded.

ALTER TABLE nodes ADD COLUMN forked_from_node_id TEXT;
ALTER TABLE nodes ADD COLUMN fork_boundary_message_id TEXT;
ALTER TABLE nodes ADD COLUMN inherited_message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE edges ADD COLUMN fork_kind TEXT;
ALTER TABLE edges ADD COLUMN fork_boundary_message_id TEXT;

