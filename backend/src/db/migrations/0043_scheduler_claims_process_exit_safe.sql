-- Separate files let the migration runner safely skip an already-present column.
ALTER TABLE scheduler_execution_claims ADD COLUMN process_exit_safe INTEGER NOT NULL DEFAULT 0;
