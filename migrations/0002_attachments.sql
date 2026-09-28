CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_note_idx ON attachments (note_id, created_at, id);
