-- The per-event journal from 0017 is gone: saved turns are read from turns + messages.
DROP INDEX IF EXISTS idx_harness_events_node_turn;
DROP TABLE IF EXISTS harness_events;
