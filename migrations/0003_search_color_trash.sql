ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT 'default'
  CHECK (color IN ('default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'));

ALTER TABLE notes ADD COLUMN deleted_at TEXT;

CREATE INDEX notes_trash_idx ON notes (deleted_at, archived, pinned DESC, updated_at DESC, id DESC);
