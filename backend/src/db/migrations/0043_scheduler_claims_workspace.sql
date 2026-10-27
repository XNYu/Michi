-- Early builds recorded 0034 before it gained workspace and quarantine fields.
-- Keep every reservation, including ones whose job/run has since been deleted.
ALTER TABLE scheduler_execution_claims ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
