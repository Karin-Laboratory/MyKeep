import { BlobReader, ZipReader } from "@zip.js/zip.js";
import type { FileEntry } from "@zip.js/zip.js";
import type { NoteInput } from "./types";

export interface KeepImportNote extends NoteInput {
  created_at: string;
  updated_at: string;
}

export interface KeepAttachmentRef {
  filePath: string | null;
  mimetype: string | null;
}

export interface KeepImportRecord {
  note: KeepImportNote;
  trashed: boolean;
  sourcePath: string;
  attachments: KeepAttachmentRef[];
}

export interface KeepZipResult {
  notes: KeepImportRecord[];
  total: number;
  failed: number;
  skipped: number;
  attachmentTotal: number;
  readAttachment: (sourcePath: string, reference: KeepAttachmentRef) => Promise<{ blob: Blob; filename: string; mime: string } | null>;
  close: () => Promise<void>;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", pdf: "application/pdf",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr",
  "3gp": "audio/3gpp", ogg: "audio/ogg", wav: "audio/wav",
};

function keepTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const micros = Number(text);
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  const date = new Date(micros / 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseKeepNote(value: unknown, hasAttachments = false): KeepImportNote | "skip" | "fail" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "fail";
  const source = value as Record<string, unknown>;
  if (source.isTrashed !== undefined && typeof source.isTrashed !== "boolean") return "fail";

  const title = source.title ?? "";
  const body = source.textContent ?? "";
  const pinned = source.isPinned ?? false;
  const archived = source.isArchived ?? false;
  if (typeof title !== "string" || typeof body !== "string"
    || typeof pinned !== "boolean" || typeof archived !== "boolean") return "fail";
  if (title.length > 300 || body.length > 100_000) return "fail";

  const checklist = Array.isArray(source.listContent)
    ? source.listContent.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      return typeof item.text === "string" && item.text.length <= 10_000 && typeof item.isChecked === "boolean"
        ? [{ text: item.text, checked: item.isChecked }] : [];
    })
    : [];
  const labels = Array.isArray(source.labels)
    ? source.labels.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const name = (value as Record<string, unknown>).name;
      return typeof name === "string" && name.trim() && name.trim().length <= 100 ? [name.trim().normalize("NFC")] : [];
    }).filter((name, index, all) => all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index)
    : [];
  if (checklist.length > 500 || labels.length > 50) return "fail";
  if (!title.trim() && !body.trim() && !checklist.length && !hasAttachments && source.isTrashed !== true) return "skip";

  const created = keepTimestamp(source.createdTimestampUsec);
  const updated = keepTimestamp(source.userEditedTimestampUsec);
  if (!created && !updated) return "fail";

  let url = "";
  const text = body.trim();
  if (text.length <= 2_000 && /^https?:\/\/\S+$/i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") url = text;
    } catch {
      // 本文がURLでなければ本文だけを保存する。
    }
  }

  return {
    title, body, url, pinned, archived, color: "default", checklist, labels,
    created_at: created ?? updated!, updated_at: updated ?? created!,
  };
}

function normalizePath(value: string): string | null {
  const path = value.replaceAll("\\", "/").normalize("NFC");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) return null;
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function isKeepJson(path: string): boolean {
  return /(?:^|\/)Keep\/[^/]+\.json$/i.test(path);
}

function references(value: unknown): KeepAttachmentRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const attachments = (value as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { filePath: null, mimetype: null };
    const ref = item as Record<string, unknown>;
    return {
      filePath: typeof ref.filePath === "string" ? ref.filePath : null,
      mimetype: typeof ref.mimetype === "string" ? ref.mimetype : null,
    };
  });
}

async function readLimited(entry: FileEntry, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await entry.getData(new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("entry_too_large");
      chunks.push(chunk.slice());
    },
  }), { checkCrc32: true });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function candidatePaths(sourcePath: string, filePath: string): string[] {
  const reference = normalizePath(filePath);
  if (!reference) return [];
  const directory = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  const prefix = directory.replace(/Keep$/i, "");
  const paths = [reference];
  if (/^Keep\//i.test(reference)) paths.push(`${prefix}${reference}`);
  paths.push(`${directory}/${reference}`);
  return paths.filter((path) => path.toLowerCase().startsWith(`${directory}/`.toLowerCase()));
}

function mimeFor(reference: KeepAttachmentRef, filename: string): string {
  const source = reference.mimetype?.trim().toLowerCase() ?? "";
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const inferred = MIME_BY_EXTENSION[extension];
  if (source === "image/jpg") return "image/jpeg";
  if (source === "application/octet-stream" && inferred?.startsWith("image/")) return inferred;
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(source) && source.length <= 100) return source;
  return inferred ?? "application/octet-stream";
}

export async function readKeepZip(file: Blob): Promise<KeepZipResult> {
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    const byPath = new Map<string, FileEntry | null>();
    const byFoldedPath = new Map<string, FileEntry | null>();
    const jsonEntries: { path: string; entry: FileEntry }[] = [];
    for (const entry of entries) {
      if (entry.directory || entry.symlink) continue;
      const path = normalizePath(entry.filename);
      if (!path || !/(?:^|\/)Keep\//i.test(path)) continue;
      if (byPath.has(path)) byPath.set(path, null);
      else byPath.set(path, entry);
      const folded = path.toLowerCase();
      if (byFoldedPath.has(folded)) byFoldedPath.set(folded, null);
      else byFoldedPath.set(folded, entry);
      if (isKeepJson(path)) jsonEntries.push({ path, entry });
    }
    if (!jsonEntries.length) throw new Error("ZIP内にGoogle KeepのJSONが見つかりません。");

    function findEntry(sourcePath: string, reference: KeepAttachmentRef): FileEntry | null {
      if (!reference.filePath) return null;
      for (const candidate of candidatePaths(sourcePath, reference.filePath)) {
        const alternate = /\.jpeg$/i.test(candidate) ? candidate.replace(/\.jpeg$/i, ".jpg")
          : /\.jpg$/i.test(candidate) ? candidate.replace(/\.jpg$/i, ".jpeg") : null;
        for (const path of alternate ? [candidate, alternate] : [candidate]) {
          const exact = byPath.get(path);
          if (exact) return exact;
          if (exact === null) return null;
          const folded = byFoldedPath.get(path.toLowerCase());
          if (folded) return folded;
          if (folded === null) return null;
        }
      }
      return null;
    }

    const result: KeepZipResult = {
      notes: [], total: jsonEntries.length, failed: 0, skipped: 0, attachmentTotal: 0,
      async readAttachment(sourcePath, reference) {
        const entry = findEntry(sourcePath, reference);
        if (!entry || entry.encrypted || !entry.uncompressedSize || entry.uncompressedSize > MAX_ATTACHMENT_BYTES) return null;
        const filename = normalizePath(entry.filename)?.split("/").at(-1) ?? "";
        if (!filename || filename.length > 255 || /[\x00-\x1f\x7f]/.test(filename)) return null;
        const mime = mimeFor(reference, filename);
        const bytes = await readLimited(entry, MAX_ATTACHMENT_BYTES);
        return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }), filename, mime };
      },
      close: () => reader.close(),
    };
    for (const { path, entry } of jsonEntries) {
      if (byPath.get(path) !== entry || entry.encrypted || entry.uncompressedSize > MAX_JSON_BYTES) {
        result.failed += 1;
        continue;
      }
      try {
        const bytes = await readLimited(entry, MAX_JSON_BYTES);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const attachments = references(value);
        const note = parseKeepNote(value, attachments.length > 0);
        if (note === "skip") result.skipped += 1;
        else if (note === "fail") result.failed += 1;
        else {
          result.notes.push({ note, trashed: (value as Record<string, unknown>).isTrashed === true, sourcePath: path, attachments });
          result.attachmentTotal += attachments.length;
        }
      } catch {
        result.failed += 1;
      }
    }
    return result;
  } catch (error) {
    await reader.close();
    throw error;
  }
}
