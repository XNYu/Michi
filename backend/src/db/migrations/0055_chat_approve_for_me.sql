-- Approve for me (Kiro V3 trust classifier) on top of permission_mode 'ask'.
-- A separate flag keeps permission_mode's CHECK and older Backends, which read Ask.
ALTER TABLE nodes ADD COLUMN permission_approve_for_me INTEGER NOT NULL DEFAULT 0 CHECK (permission_approve_for_me IN (0, 1));
