import { BlobReader, BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import type { Attachment, Note } from "./types";

type ExportView = "active" | "archived" | "trash";
type BackupAttachment = Pick<Attachment, "id" | "filename" | "mime_type" | "created_at"> & { zip_path: string | null };

export interface BackupProgress {
  stage: "notes" | "attachments" | "zip" | "done";
  notesDone: number;
  notesTotal: number;
  attachmentsDone: number;
  attachmentsTotal: number;
  attachmentsSucceeded: number;
  attachmentsFailed: number;
}

export interface BackupResult {
  blob: Blob | null;
  notes: number;
  attachmentsSucceeded: number;
  attachmentsFailed: number;
}

function safeFileName(attachment: Attachment): string {
  const normalized = attachment.filename.normalize("NFC")
    .replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  const dot = normalized.lastIndexOf(".");
  const extension = dot > 0 ? normalized.slice(dot, dot + 21) : "";
  const stem = (dot > 0 ? normalized.slice(0, dot) : normalized).slice(0, 120) || "file";
  return `${attachment.id.replace(/[^a-zA-Z0-9-]/g, "_")}-${stem}${extension}`;
}

function markdown(note: Note, attachments: BackupAttachment[]): string {
  const lines = [
    `# ${note.title.replace(/[\r\n]+/g, " ") || "無題"}`,
    "",
    `作成日時: ${note.created_at}`,
    `更新日時: ${note.updated_at}`,
    `状態: ${note.deleted_at ? "ゴミ箱" : note.archived ? "アーカイブ" : "メモ"}${note.pinned ? " / ピン留め" : ""}`,
  ];
  if (note.body) lines.push("", note.body);
  if (note.url) lines.push("", "URL:", `<${note.url}>`);
  if (note.checklist.length) {
    lines.push("", "## Checklist", "");
    for (const item of note.checklist) {
      lines.push(`- [${item.checked ? "x" : " "}] ${item.text.replace(/\r?\n/g, "\n  ")}`);
    }
  }
  if (note.labels.length) lines.push("", "## Labels", "", note.labels.join(", "));
  if (attachments.length) {
    lines.push("", "## Attachments", "");
    for (const attachment of attachments) {
      lines.push(`- ${attachment.zip_path ?? `${attachment.filename}（取得失敗）`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function getJson<T>(path: string, fetcher: (path: string) => Promise<Response>): Promise<T> {
  const response = await fetcher(path);
  if (!response.ok) throw new Error(`データ取得に失敗しました（HTTP ${response.status}）。`);
  return await response.json() as T;
}

export function backupFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `mykeep-backup-${year}-${month}-${day}.zip`;
}

export async function createBackup(
  output: BlobWriter | WritableStream<Uint8Array>,
  onProgress: (progress: BackupProgress) => void,
  fetcher: (path: string) => Promise<Response> = (path) => fetch(path),
): Promise<BackupResult> {
  const counts = await getJson<{ notes: number; attachments: number }>("/api/export/counts", fetcher);
  const progress: BackupProgress = {
    stage: "notes", notesDone: 0, notesTotal: counts.notes,
    attachmentsDone: 0, attachmentsTotal: counts.attachments,
    attachmentsSucceeded: 0, attachmentsFailed: 0,
  };
  onProgress({ ...progress });

  const notes: Note[] = [];
  const seen = new Set<string>();
  for (const view of ["active", "archived", "trash"] satisfies ExportView[]) {
    let offset = 0;
    while (true) {
      const page = await getJson<{ notes: Note[]; hasMore: boolean }>(`/api/notes?view=${view}&offset=${offset}`, fetcher);
      if (!Array.isArray(page.notes) || (page.hasMore && !page.notes.length)) throw new Error("メモ一覧の応答が正しくありません。");
      for (const note of page.notes) {
        if (!seen.has(note.id)) {
          notes.push(note);
          seen.add(note.id);
        }
      }
      offset += page.notes.length;
      progress.notesDone = notes.length;
      onProgress({ ...progress });
      if (!page.hasMore) break;
    }
  }

  progress.stage = "attachments";
  progress.attachmentsTotal = notes.reduce((sum, note) => sum + note.attachments.length, 0);
  onProgress({ ...progress });

  const writer = new ZipWriter<Blob | undefined>(output, { useWebWorkers: false, bufferedWrite: false, useUnicodeFileNames: true });
  const exportedNotes = [];
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    const attachments: BackupAttachment[] = [];
    for (const attachment of note.attachments) {
      const zipPath = `attachments/${safeFileName(attachment)}`;
      let savedPath: string | null = null;
      try {
        const response = await fetcher(attachment.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("empty_attachment");
        await writer.add(zipPath, new BlobReader(blob), { level: 0 });
        savedPath = zipPath;
        progress.attachmentsSucceeded += 1;
      } catch (error) {
        if (writer.hasCorruptedEntries) throw error;
        progress.attachmentsFailed += 1;
      }
      attachments.push({ id: attachment.id, filename: attachment.filename,
        mime_type: attachment.mime_type, created_at: attachment.created_at, zip_path: savedPath });
      progress.attachmentsDone += 1;
      onProgress({ ...progress });
    }
    const markdownPath = `markdown/note-${String(index + 1).padStart(6, "0")}.md`;
    exportedNotes.push({
      id: note.id, title: note.title, body: note.body, url: note.url, color: note.color,
      preview_title: note.preview_title, preview_description: note.preview_description,
      preview_image: note.preview_image, preview_hostname: note.preview_hostname,
      card_image: note.card_image ?? "auto",
      pinned: note.pinned, pin_level: note.pin_level, archived: note.archived, trashed: note.deleted_at !== null,
      deleted_at: note.deleted_at, created_at: note.created_at, updated_at: note.updated_at,
      checklist: note.checklist.map((item) => ({ id: item.id, text: item.text, checked: item.checked, order: item.position })),
      labels: note.labels, attachments, markdown_path: markdownPath,
    });
    await writer.add(markdownPath, new TextReader(markdown(note, attachments)));
  }

  progress.stage = "zip";
  onProgress({ ...progress });
  await writer.add("notes.json", new TextReader(JSON.stringify({
    format: "mykeep-backup", version: 1, exported_at: new Date().toISOString(), notes: exportedNotes,
  }, null, 2)));
  const blob = await writer.close();
  progress.stage = "done";
  onProgress({ ...progress });
  return { blob: blob instanceof Blob ? blob : null, notes: notes.length,
    attachmentsSucceeded: progress.attachmentsSucceeded, attachmentsFailed: progress.attachmentsFailed };
}
