-- Michi Home inspiration cards. home_cards holds, per owner, the greeting and
-- card sets the Meta agent wrote last; a rewrite replaces the row.
-- home_card_uses keeps the cards the user clicked across rewrites, so a writer
-- that reuses a card id for the same suggestion keeps it hidden.
CREATE TABLE home_cards (
  owner_user_id TEXT PRIMARY KEY,
  greeting TEXT CHECK(greeting IS NULL OR json_valid(greeting)),
  sets TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sets) AND json_type(sets)='array'),
  input_fingerprint TEXT,
  generated_at INTEGER NOT NULL
);

CREATE TABLE home_card_uses (
  owner_user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, card_id)
);
