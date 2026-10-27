-- Scheduled Pages maintenance owns a durable chat node whose runtime profile
-- must not be changed by ordinary session recovery or client graph sync.
-- Intentionally no FK: deleting a job must leave the node marked and fail closed.
ALTER TABLE nodes ADD COLUMN maintenance_job_id TEXT;
