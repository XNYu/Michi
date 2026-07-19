-- 0010_node_last_applied_seq: track the last applied message seq within a turn.
--
-- The frontend sync payload includes `last_applied_seq` alongside
-- `last_applied_turn_id`. Without this column, saveNode's spread parameter
-- bag passes the field to better-sqlite3 which rejects unknown named params.

ALTER TABLE nodes ADD COLUMN last_applied_seq INTEGER;
