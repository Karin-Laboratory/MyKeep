ALTER TABLE notes ADD COLUMN pin_level INTEGER NOT NULL DEFAULT 0 CHECK (pin_level BETWEEN 0 AND 3);
UPDATE notes SET pin_level = 1 WHERE pinned = 1;
