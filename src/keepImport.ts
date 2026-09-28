import { Unzip, UnzipInflate } from "fflate";
import type { NoteInput } from "./types";

export interface KeepImportNote extends NoteInput {
  created_at: string;
  updated_at: string;
}

export interface KeepZipResult {
  notes: KeepImportNote[];
  total: number;
  failed: number;
  skipped: number;
}

const MAX_JSON_BYTES = 1024 * 1024;

function keepTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const micros = Number(text);
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  const date = new Date(micros / 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseKeepNote(value: unknown): KeepImportNote | "skip" | "fail" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "fail";
  const source = value as Record<string, unknown>;
  if (source.isTrashed === true) return "skip";
  if (source.isTrashed !== undefined && typeof source.isTrashed !== "boolean") return "fail";

  const title = source.title ?? "";
  const body = source.textContent ?? "";
  const pinned = source.isPinned ?? false;
  const archived = source.isArchived ?? false;
  if (typeof title !== "string" || typeof body !== "string"
    || typeof pinned !== "boolean" || typeof archived !== "boolean") return "fail";
  if (title.length > 300 || body.length > 100_000) return "fail";
  if (Array.isArray(source.listContent) && source.listContent.length && !body.trim()) return "skip";
  if (!title.trim() && !body.trim()) return "skip";

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
    title, body, url, pinned, archived, color: "default",
    created_at: created ?? updated!, updated_at: updated ?? created!,
  };
}

function isKeepJson(path: string): boolean {
  return /(?:^|\/)Keep\/[^/]+\.json$/i.test(path.replaceAll("\\", "/"));
}

export async function readKeepZip(file: Blob): Promise<KeepZipResult> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b
    || signature[2] !== 0x03 || signature[3] !== 0x04) {
    throw new Error("ZIPファイルを選択してください。");
  }

  const result: KeepZipResult = { notes: [], total: 0, failed: 0, skipped: 0 };
  const unzip = new Unzip((entry) => {
    if (!isKeepJson(entry.name)) {
      entry.ondata = () => {};
      entry.start();
      return;
    }

    result.total += 1;
    let chunks: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    entry.ondata = (error, chunk, final) => {
      if (finished) return;
      if (error) {
        result.failed += 1;
        finished = true;
        chunks = [];
        return;
      }
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        result.failed += 1;
        finished = true;
        chunks = [];
        return;
      }
      chunks.push(chunk.slice());
      if (!final) return;

      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const parsed = parseKeepNote(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (parsed === "skip") result.skipped += 1;
        else if (parsed === "fail") result.failed += 1;
        else result.notes.push(parsed);
      } catch {
        result.failed += 1;
      }
      finished = true;
      chunks = [];
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      unzip.push(value);
    }
    unzip.push(new Uint8Array(), true);
  } catch {
    throw new Error("ZIPを読み取れませんでした。");
  } finally {
    reader.releaseLock();
  }
  if (!result.total) throw new Error("ZIP内にGoogle KeepのJSONが見つかりません。");
  return result;
}
