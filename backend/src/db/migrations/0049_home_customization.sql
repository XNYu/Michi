-- User-directed Home overrides survive automatic regeneration.
CREATE TABLE home_customization (
  owner_user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  preferences TEXT NOT NULL CHECK(json_valid(preferences))
);
