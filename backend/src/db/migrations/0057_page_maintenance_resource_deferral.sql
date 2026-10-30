-- The maintenance run that left this page pending because a conversation was editing it.
-- Keep this ALTER alone: the runner accepts duplicate columns on newer databases.
ALTER TABLE page_maintenance_resources ADD COLUMN deferred_run_id TEXT;
