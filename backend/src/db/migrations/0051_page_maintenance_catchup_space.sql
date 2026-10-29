-- Early installations recorded 0035 before catch-up requests became Space-scoped.
-- Keep this ALTER alone: the runner accepts duplicate columns on newer databases.
-- Legacy requests have no trustworthy Space identity; 0053 cancels queued ones.
ALTER TABLE page_maintenance_catchup_requests ADD COLUMN space_id TEXT REFERENCES pages(id) ON DELETE CASCADE;
