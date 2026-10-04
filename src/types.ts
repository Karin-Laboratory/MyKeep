export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  url: string;
  created_at: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  position: number;
}

export type ChecklistInput = Pick<ChecklistItem, "text" | "checked">;

export const NOTE_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export type CardImageChoice = "auto" | "preview" | `attachment:${string}`;

export interface NotePreview {
  preview_title: string;
  preview_description: string;
  preview_image: string;
  preview_hostname: string;
}

export interface Note extends NotePreview {
  card_image: CardImageChoice;
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: boolean;
  pin_level: number;
  sort_order: number;
  archived: boolean;
  color: NoteColor;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  attachments: Attachment[];
  checklist: ChecklistItem[];
  labels: string[];
}

export type NoteInput = Pick<Note, "title" | "body" | "url" | "pinned" | "archived" | "color"> & Partial<NotePreview> & {
  pin_level?: number;
  card_image?: CardImageChoice;
  checklist?: ChecklistInput[];
  labels?: string[];
};
