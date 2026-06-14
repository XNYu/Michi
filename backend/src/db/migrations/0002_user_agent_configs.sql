CREATE TABLE IF NOT EXISTS user_agent_configs (
  user_id              TEXT PRIMARY KEY,
  runtime              TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model_by_runtime     TEXT NOT NULL DEFAULT '{}',
  reasoning_by_runtime TEXT NOT NULL DEFAULT '{}',
  updated_at           INTEGER NOT NULL
);
