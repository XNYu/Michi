-- Task activity reads a database's pending row suggestions and its recent upkeep
-- changes on every refresh; both must not walk the database's whole change history.
CREATE INDEX IF NOT EXISTS idx_page_changes_database_pending ON page_changes(database_id, seq) WHERE proposal_state='pending';
CREATE INDEX IF NOT EXISTS idx_page_changes_database_created ON page_changes(database_id, created_at) WHERE database_id IS NOT NULL;
