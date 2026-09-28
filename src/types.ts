export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  url: string;
  created_at: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
}

export type NoteInput = Pick<Note, "title" | "body" | "url" | "pinned" | "archived">;
