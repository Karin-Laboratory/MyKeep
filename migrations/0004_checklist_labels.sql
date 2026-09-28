CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL CHECK (checked IN (0, 1))
);

CREATE INDEX checklist_note_idx ON checklist_items (note_id, position, id);

CREATE TABLE labels (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE note_labels (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  label_key TEXT NOT NULL REFERENCES labels(name_key) ON DELETE CASCADE,
  PRIMARY KEY (note_id, label_key)
);

CREATE INDEX note_labels_label_idx ON note_labels (label_key, note_id);
