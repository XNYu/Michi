-- When the workspace's owner last had the conversation on screen (renderer
-- wall-clock ms). Only ever moves forward; graph snapshots never write it.
ALTER TABLE nodes ADD COLUMN viewed_at INTEGER;
