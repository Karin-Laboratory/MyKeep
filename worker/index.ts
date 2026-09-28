import type { Attachment, Note, NoteInput } from "../src/types";

interface NoteRow {
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  note_id: string;
  filename: string;
  mime_type: string;
  r2_key: string;
  created_at: string;
}

const SELECT_NOTE = "SELECT id, title, body, url, pinned, archived, created_at, updated_at FROM notes";
const PAGE_SIZE = 50;
const MAX_REQUEST_BYTES = 120_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function toNote(row: NoteRow, attachments: Attachment[] = []): Note {
  return { ...row, pinned: row.pinned === 1, archived: row.archived === 1, attachments };
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    url: `/api/notes/${row.note_id}/attachments/${row.id}/image`,
    created_at: row.created_at,
  };
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readInput(request: Request): Promise<unknown> {
  const bytes = await readBytes(request, MAX_REQUEST_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

function parseInput(value: unknown, current?: NoteRow): NoteInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const title = input.title ?? current?.title ?? "";
  const body = input.body ?? current?.body ?? "";
  const url = input.url ?? current?.url ?? "";
  const pinned = input.pinned ?? (current ? current.pinned === 1 : false);
  const archived = input.archived ?? (current ? current.archived === 1 : false);

  if (typeof title !== "string" || title.length > 300) return null;
  if (typeof body !== "string" || body.length > 100_000) return null;
  if (typeof url !== "string" || url.length > 2_000) return null;
  if (typeof pinned !== "boolean" || typeof archived !== "boolean") return null;
  if (!title.trim() && !body.trim() && !url.trim()) return null;

  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return { title, body, url, pinned, archived };
}

async function listNotes(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "active";
  const offset = Number(params.get("offset") ?? "0");
  if ((view !== "active" && view !== "archived") || !Number.isSafeInteger(offset) || offset < 0) {
    return json({ error: "一覧の指定が正しくありません。" }, 400);
  }

  const result = await env.DB.prepare(
    `${SELECT_NOTE} WHERE archived = ? ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).bind(view === "archived" ? 1 : 0, PAGE_SIZE + 1, offset).all<NoteRow>();
  const rows = result.results ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  const byNote = new Map<string, Attachment[]>();
  if (page.length) {
    const placeholders = page.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE note_id IN (${placeholders}) ORDER BY created_at, id`,
    ).bind(...page.map((row) => row.id)).all<AttachmentRow>();
    for (const row of result.results ?? []) {
      const attachments = byNote.get(row.note_id) ?? [];
      attachments.push(toAttachment(row));
      byNote.set(row.note_id, attachments);
    }
  }
  return json({ notes: page.map((row) => toNote(row, byNote.get(row.id))), hasMore: rows.length > PAGE_SIZE });
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const input = parseInput(await readInput(request));
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO notes (id, title, body, url, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, input.title, input.body, input.url, Number(input.pinned), Number(input.archived), now, now).run();
  return json({ note: { id, ...input, created_at: now, updated_at: now, attachments: [] } satisfies Note }, 201);
}

async function updateNote(id: string, request: Request, env: Env): Promise<Response> {
  const current = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  if (!current) return json({ error: "メモが見つかりません。" }, 404);
  const input = parseInput(await readInput(request), current);
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE notes SET title = ?, body = ?, url = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?",
  ).bind(input.title, input.body, input.url, Number(input.pinned), Number(input.archived), now, id).run();
  const result = await env.DB.prepare(
    "SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE note_id = ? ORDER BY created_at, id",
  ).bind(id).all<AttachmentRow>();
  return json({ note: { id, ...input, created_at: current.created_at, updated_at: now, attachments: (result.results ?? []).map(toAttachment) } satisfies Note });
}

async function deleteNote(id: string, env: Env): Promise<Response> {
  const attachmentsResult = await env.DB.prepare("SELECT r2_key FROM attachments WHERE note_id = ?").bind(id).all<{ r2_key: string }>();
  const keys = (attachmentsResult.results ?? []).map((row) => row.r2_key);
  for (let index = 0; index < keys.length; index += 1000) {
    await env.IMAGES.delete(keys.slice(index, index + 1000));
  }
  const result = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return json({ error: "メモが見つかりません。" }, 404);
  return json({ ok: true });
}

async function uploadAttachment(noteId: string, request: Request, env: Env): Promise<Response> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(noteId).first();
  if (!note) return json({ error: "メモが見つかりません。" }, 404);

  const mime = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!IMAGE_TYPES.has(mime)) return json({ error: "対応していない画像形式です。" }, 415);

  let filename: string;
  try {
    filename = decodeURIComponent(request.headers.get("X-File-Name") ?? "").trim();
  } catch {
    return json({ error: "ファイル名を確認してください。" }, 400);
  }
  if (!filename || filename.length > 255 || /[\x00-\x1f\x7f]/.test(filename)) {
    return json({ error: "ファイル名を確認してください。" }, 400);
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_IMAGE_BYTES) return json({ error: "画像は20MB以下にしてください。" }, 413);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(request, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return json({ error: "画像は20MB以下にしてください。" }, 413);
    }
    throw error;
  }
  if (!bytes.length) return json({ error: "画像が空です。" }, 400);

  const id = crypto.randomUUID();
  const key = `notes/${noteId}/${id}`;
  const createdAt = new Date().toISOString();
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare(
      "INSERT INTO attachments (id, note_id, filename, mime_type, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, noteId, filename, mime, key, createdAt).run();
  } catch (error) {
    await env.IMAGES.delete(key);
    throw error;
  }
  return json({ attachment: toAttachment({ id, note_id: noteId, filename, mime_type: mime, r2_key: key, created_at: createdAt }) }, 201);
}

async function getAttachment(noteId: string, attachmentId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key, mime_type FROM attachments WHERE id = ? AND note_id = ?",
  ).bind(attachmentId, noteId).first<Pick<AttachmentRow, "r2_key" | "mime_type">>();
  if (!row) return json({ error: "画像が見つかりません。" }, 404);
  const object = await env.IMAGES.get(row.r2_key);
  if (!object || !("body" in object)) return json({ error: "画像が見つかりません。" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(object.size),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "ETag": object.httpEtag,
    },
  });
}

async function deleteAttachment(noteId: string, attachmentId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key FROM attachments WHERE id = ? AND note_id = ?",
  ).bind(attachmentId, noteId).first<{ r2_key: string }>();
  if (!row) return json({ error: "画像が見つかりません。" }, 404);
  await env.IMAGES.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM attachments WHERE id = ? AND note_id = ?").bind(attachmentId, noteId).run();
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "見つかりません。" }, 404);

    if (request.method !== "GET") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "この操作は許可されていません。" }, 403);
    }

    try {
      if (url.pathname === "/api/notes") {
        if (request.method === "GET") return await listNotes(request, env);
        if (request.method === "POST") return await createNote(request, env);
      }

      const attachmentsMatch = /^\/api\/notes\/([0-9a-f-]{36})\/attachments$/.exec(url.pathname);
      if (attachmentsMatch && request.method === "POST") {
        return await uploadAttachment(attachmentsMatch[1], request, env);
      }

      const imageMatch = /^\/api\/notes\/([0-9a-f-]{36})\/attachments\/([0-9a-f-]{36})\/image$/.exec(url.pathname);
      if (imageMatch && request.method === "GET") {
        return await getAttachment(imageMatch[1], imageMatch[2], env);
      }

      const attachmentMatch = /^\/api\/notes\/([0-9a-f-]{36})\/attachments\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (attachmentMatch && request.method === "DELETE") {
        return await deleteAttachment(attachmentMatch[1], attachmentMatch[2], env);
      }

      const match = /^\/api\/notes\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match) {
        if (request.method === "PATCH") return await updateNote(match[1], request, env);
        if (request.method === "DELETE") return await deleteNote(match[1], env);
      }
      return json({ error: "見つかりません。" }, 404);
    } catch (error) {
      if (error instanceof Error && ["empty_body", "body_too_large", "invalid_json"].includes(error.message)) {
        return json({ error: "送信内容を確認してください。" }, error.message === "body_too_large" ? 413 : 400);
      }
      console.error("note_api_failed", error);
      return json({ error: "処理に失敗しました。" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
