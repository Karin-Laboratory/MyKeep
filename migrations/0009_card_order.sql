ALTER TABLE notes ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
WITH ranked AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY archived, CASE WHEN pinned = 0 THEN 0 WHEN pin_level = 0 THEN 1 ELSE pin_level END ORDER BY updated_at DESC, id DESC) AS position FROM notes)
UPDATE notes SET sort_order = (SELECT position * 1024 FROM ranked WHERE ranked.id = notes.id);
