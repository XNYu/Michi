CREATE TABLE home_reminders (
  owner_user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version TEXT NOT NULL,
  until_at INTEGER,
  PRIMARY KEY (owner_user_id, item_id)
);
