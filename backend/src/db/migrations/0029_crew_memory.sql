ALTER TABLE nodes ADD COLUMN crew_memory_mode TEXT CHECK (crew_memory_mode IN ('persistent', 'incognito', 'temporary'));
