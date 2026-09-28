export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  url: string;
  created_at: string;
}

export const NOTE_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface Note {
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: boolean;
  archived: boolean;
  color: NoteColor;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
}

export type NoteInput = Pick<Note, "title" | "body" | "url" | "pinned" | "archived" | "color">;
