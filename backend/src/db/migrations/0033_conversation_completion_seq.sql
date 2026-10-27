-- Current state only: no event/change log and no history backfill.
ALTER TABLE turns ADD COLUMN completion_seq INTEGER;
ALTER TABLE scheduled_jobs ADD COLUMN conversation_cursor INTEGER;
CREATE INDEX idx_turns_node_completion ON turns(node_id, completion_seq)
  WHERE completion_seq IS NOT NULL;
