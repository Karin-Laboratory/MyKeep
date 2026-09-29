import { NOTE_COLORS } from "../src/types";
import { linkPreview } from "./linkPreview";
import type { Attachment, ChecklistItem, Note, NoteColor, NoteInput } from "../src/types";

interface NoteRow {
  id: string;
  title: string;
  body: string;
  url: string;
  pinned: number;
  archived: number;
  color: NoteColor;
  deleted_at: string | null;
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

interface ChecklistRow {
  id: string;
  note_id: string;
  position: number;
  text: string;
  checked: number;
}

interface LabelRow {
  note_id: string;
  name: string;
}

const SELECT_NOTE = "SELECT id, title, body, url, pinned, archived, color, deleted_at, created_at, updated_at FROM notes";
const PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 200;
const MAX_CHECKLIST_ITEMS = 500;
const MAX_LABELS = 50;
const MAX_REQUEST_BYTES = 120_000;
const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CAPTURE_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MIME_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const COLOR_SET = new Set<string>(NOTE_COLORS);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function toNote(row: NoteRow, attachments: Attachment[] = [], checklist: ChecklistItem[] = [], labels: string[] = []): Note {
  return { ...row, pinned: row.pinned === 1, archived: row.archived === 1, attachments, checklist, labels };
}

function labelKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
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

function validFilename(filename: string): boolean {
  return !!filename && filename.length <= 255 && !/[\x00-\x1f\x7f]/.test(filename);
}

async function matchesApiKey(header: string | null, secret: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  if (!match || match[1].length > 512) return false;
  const encoder = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const a = new Uint8Array(provided);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
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

async function readInput(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

function parseInput(value: unknown, current?: NoteRow, allowEmpty = false): NoteInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const title = input.title ?? current?.title ?? "";
  const body = input.body ?? current?.body ?? "";
  const url = input.url ?? current?.url ?? "";
  const pinned = input.pinned ?? (current ? current.pinned === 1 : false);
  const archived = input.archived ?? (current ? current.archived === 1 : false);
  const color = input.color ?? current?.color ?? "default";

  let checklist: NoteInput["checklist"];
  if (input.checklist !== undefined) {
    if (!Array.isArray(input.checklist) || input.checklist.length > MAX_CHECKLIST_ITEMS) return null;
    checklist = [];
    for (const value of input.checklist) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      if (typeof item.text !== "string" || item.text.length > 10_000 || typeof item.checked !== "boolean") return null;
      checklist.push({ text: item.text, checked: item.checked });
    }
  }
  let labels: string[] | undefined;
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels) || input.labels.length > MAX_LABELS) return null;
    const seen = new Set<string>();
    labels = [];
    for (const value of input.labels) {
      if (typeof value !== "string") return null;
      const name = value.trim().normalize("NFC");
      if (!name || name.length > 100) return null;
      const key = labelKey(name);
      if (!seen.has(key)) {
        labels.push(name);
        seen.add(key);
      }
    }
  }

  if (typeof title !== "string" || title.length > 300) return null;
  if (typeof body !== "string" || body.length > 100_000) return null;
  if (typeof url !== "string" || url.length > 2_000) return null;
  if (typeof pinned !== "boolean" || typeof archived !== "boolean") return null;
  if (typeof color !== "string" || !COLOR_SET.has(color)) return null;
  if (!title.trim() && !body.trim() && !url.trim() && !checklist?.length && !current && !allowEmpty) return null;

  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return { title, body, url, pinned, archived, color: color as NoteColor, checklist, labels };
}

async function withRelations(rows: NoteRow[], env: Env): Promise<Note[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const [attachments, items, labels] = await Promise.all([
    env.DB.prepare(`SELECT id, note_id, filename, mime_type, r2_key, created_at FROM attachments WHERE note_id IN (${placeholders}) ORDER BY created_at, id`).bind(...ids).all<AttachmentRow>(),
    env.DB.prepare(`SELECT id, note_id, position, text, checked FROM checklist_items WHERE note_id IN (${placeholders}) ORDER BY position, id`).bind(...ids).all<ChecklistRow>(),
    env.DB.prepare(`SELECT nl.note_id, l.name FROM note_labels nl JOIN labels l ON l.name_key = nl.label_key WHERE nl.note_id IN (${placeholders}) ORDER BY l.name`).bind(...ids).all<LabelRow>(),
  ]);
  const byAttachment = new Map<string, Attachment[]>();
  const byChecklist = new Map<string, ChecklistItem[]>();
  const byLabel = new Map<string, string[]>();
  for (const row of attachments.results ?? []) {
    const list = byAttachment.get(row.note_id) ?? [];
    list.push(toAttachment(row));
    byAttachment.set(row.note_id, list);
  }
  for (const row of items.results ?? []) {
    const list = byChecklist.get(row.note_id) ?? [];
    list.push({ id: row.id, text: row.text, checked: row.checked === 1, position: row.position });
    byChecklist.set(row.note_id, list);
  }
  for (const row of labels.results ?? []) {
    const list = byLabel.get(row.note_id) ?? [];
    list.push(row.name);
    byLabel.set(row.note_id, list);
  }
  return rows.map((row) => toNote(row, byAttachment.get(row.id), byChecklist.get(row.id), byLabel.get(row.id)));
}

async function listNotes(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const view = params.get("view") ?? "active";
  const offset = Number(params.get("offset") ?? "0");
  const query = params.get("q")?.trim() ?? "";
  const label = params.get("label")?.trim() ?? "";
  if ((view !== "active" && view !== "archived" && view !== "trash")
    || !Number.isSafeInteger(offset) || offset < 0 || query.length > MAX_SEARCH_LENGTH || label.length > 100) {
    return json({ error: "一覧の指定が正しくありません。" }, 400);
  }

  const conditions = view === "trash" ? ["deleted_at IS NOT NULL"] : ["deleted_at IS NULL", "archived = ?"];
  const bindings: (string | number)[] = view === "trash" ? [] : [view === "archived" ? 1 : 0];
  if (query) {
    conditions.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)");
    bindings.push(query, query, query);
  }
  if (label) {
    conditions.push("EXISTS (SELECT 1 FROM note_labels nl WHERE nl.note_id = notes.id AND nl.label_key = ?)");
    bindings.push(labelKey(label));
  }
  const order = view === "trash" ? "deleted_at DESC, id DESC" : "pinned DESC, updated_at DESC, id DESC";
  const result = await env.DB.prepare(
    `${SELECT_NOTE} WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).bind(...bindings, PAGE_SIZE + 1, offset).all<NoteRow>();
  const rows = result.results ?? [];
  const page = rows.slice(0, PAGE_SIZE);
  return json({ notes: await withRelations(page, env), hasMore: rows.length > PAGE_SIZE });
}

async function listLabels(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT l.name FROM labels l WHERE EXISTS (SELECT 1 FROM note_labels nl WHERE nl.label_key = l.name_key) ORDER BY l.name",
  ).all<{ name: string }>();
  return json({ labels: (result.results ?? []).map((row) => row.name) });
}

async function exportCounts(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM attachments) AS attachments",
  ).first<{ notes: number; attachments: number }>();
  return json({ notes: counts?.notes ?? 0, attachments: counts?.attachments ?? 0 });
}

function relationStatements(noteId: string, input: NoteInput, env: Env, replace: boolean): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (input.checklist !== undefined) {
    if (replace) statements.push(env.DB.prepare("DELETE FROM checklist_items WHERE note_id = ?").bind(noteId));
    for (let start = 0; start < input.checklist.length; start += 20) {
      const values = input.checklist.slice(start, start + 20);
      const placeholders = values.map(() => "(?, ?, ?, ?, ?)").join(",");
      const bindings = values.flatMap((item, index) => [crypto.randomUUID(), noteId, start + index, item.text, Number(item.checked)]);
      statements.push(env.DB.prepare(
        `INSERT INTO checklist_items (id, note_id, position, text, checked) VALUES ${placeholders}`,
      ).bind(...bindings));
    }
  }
  if (input.labels !== undefined) {
    if (replace) statements.push(env.DB.prepare("DELETE FROM note_labels WHERE note_id = ?").bind(noteId));
    if (input.labels.length) {
      const placeholders = input.labels.map(() => "(?, ?)").join(",");
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO labels (name_key, name) VALUES ${placeholders}`)
        .bind(...input.labels.flatMap((name) => [labelKey(name), name])));
      statements.push(env.DB.prepare(`INSERT INTO note_labels (note_id, label_key) VALUES ${placeholders}`)
        .bind(...input.labels.flatMap((name) => [noteId, labelKey(name)])));
    }
  }
  return statements;
}

async function insertNote(input: NoteInput, env: Env, timestamps?: { created_at: string; updated_at: string }): Promise<Note> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const createdAt = timestamps?.created_at ?? now;
  const updatedAt = timestamps?.updated_at ?? now;
  const statements = [env.DB.prepare(
    "INSERT INTO notes (id, title, body, url, pinned, archived, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, input.title, input.body, input.url, Number(input.pinned), Number(input.archived), input.color, createdAt, updatedAt),
  ...relationStatements(id, input, env, false)];
  await env.DB.batch(statements);
  const row = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  return (await withRelations([row!], env))[0];
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const input = parseInput(await readInput(request));
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);
  return json({ note: await insertNote(input, env) }, 201);
}

async function importKeepNote(request: Request, env: Env): Promise<Response> {
  const value = await readInput(request, MAX_IMPORT_BYTES);
  const input = parseInput(value, undefined, true);
  if (!input || !value || typeof value !== "object" || Array.isArray(value)) {
    return json({ error: "インポートするメモを確認してください。" }, 400);
  }
  const { created_at, updated_at } = value as Record<string, unknown>;
  if (typeof created_at !== "string" || typeof updated_at !== "string"
    || !Number.isFinite(Date.parse(created_at)) || !Number.isFinite(Date.parse(updated_at))
    || new Date(created_at).toISOString() !== created_at || new Date(updated_at).toISOString() !== updated_at) {
    return json({ error: "日時を確認してください。" }, 400);
  }
  return json({ note: await insertNote(input, env, { created_at, updated_at }) }, 201);
}

async function updateNote(id: string, request: Request, env: Env): Promise<Response> {
  const current = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<NoteRow>();
  if (!current) return json({ error: "メモが見つかりません。" }, 404);
  const input = parseInput(await readInput(request), current);
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);

  const now = new Date().toISOString();
  await env.DB.batch([env.DB.prepare(
    "UPDATE notes SET title = ?, body = ?, url = ?, pinned = ?, archived = ?, color = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  ).bind(input.title, input.body, input.url, Number(input.pinned), Number(input.archived), input.color, now, id),
  ...relationStatements(id, input, env, true)]);
  const row = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  return json({ note: (await withRelations([row!], env))[0] });
}

async function moveToTrash(id: string, env: Env): Promise<Response> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  ).bind(now, now, id).run();
  if (!result.meta.changes) return json({ error: "メモが見つかりません。" }, 404);
  return json({ ok: true });
}

async function restoreNote(id: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
  ).bind(new Date().toISOString(), id).run();
  if (!result.meta.changes) return json({ error: "メモが見つかりません。" }, 404);
  return json({ ok: true });
}

async function permanentlyDeleteNote(id: string, env: Env): Promise<Response> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
  if (!note) return json({ error: "メモが見つかりません。" }, 404);
  const attachmentsResult = await env.DB.prepare("SELECT r2_key FROM attachments WHERE note_id = ?").bind(id).all<{ r2_key: string }>();
  const keys = (attachmentsResult.results ?? []).map((row) => row.r2_key);
  for (let index = 0; index < keys.length; index += 1000) {
    await env.IMAGES.delete(keys.slice(index, index + 1000));
  }
  const result = await env.DB.prepare("DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL").bind(id).run();
  if (!result.meta.changes) return json({ error: "メモが見つかりません。" }, 404);
  return json({ ok: true });
}

async function persistAttachment(noteId: string, filename: string, mime: string, bytes: Uint8Array, env: Env): Promise<Attachment> {
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
  return toAttachment({ id, note_id: noteId, filename, mime_type: mime, r2_key: key, created_at: createdAt });
}

async function uploadAttachment(noteId: string, request: Request, env: Env): Promise<Response> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL").bind(noteId).first();
  if (!note) return json({ error: "メモが見つかりません。" }, 404);

  const mime = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!MIME_TYPE_PATTERN.test(mime) || mime.length > 100) {
    return json({ error: "添付ファイルの形式を確認してください。" }, 415);
  }

  let filename: string;
  try {
    filename = decodeURIComponent(request.headers.get("X-File-Name") ?? "").trim();
  } catch {
    return json({ error: "ファイル名を確認してください。" }, 400);
  }
  if (!validFilename(filename)) return json({ error: "ファイル名を確認してください。" }, 400);

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_IMAGE_BYTES) return json({ error: "添付ファイルは20MB以下にしてください。" }, 413);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(request, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return json({ error: "添付ファイルは20MB以下にしてください。" }, 413);
    }
    throw error;
  }
  if (!bytes.length) return json({ error: "添付ファイルが空です。" }, 400);
  return json({ attachment: await persistAttachment(noteId, filename, mime, bytes, env) }, 201);
}

async function captureNote(request: Request, env: Env): Promise<Response> {
  const secret = (env as Env & { CAPTURE_API_KEY?: string }).CAPTURE_API_KEY;
  if (!secret) return json({ error: "保存APIが設定されていません。" }, 503);
  if (!await matchesApiKey(request.headers.get("Authorization"), secret)) {
    return json({ error: "API KEYが正しくありません。" }, 401);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return json({ error: "送信形式が正しくありません。" }, 415);
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_CAPTURE_BYTES) return json({ error: "送信サイズが大きすぎます。" }, 413);
  const bytes = await readBytes(request, MAX_CAPTURE_BYTES);
  let form: FormData;
  try {
    form = await new Response(bytes.buffer as ArrayBuffer, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    return json({ error: "送信内容を確認してください。" }, 400);
  }

  const title = form.get("title");
  const url = form.get("url");
  const body = form.get("body") ?? "";
  if (typeof title !== "string" || typeof url !== "string" || !url || typeof body !== "string") {
    return json({ error: "メモの内容を確認してください。" }, 400);
  }
  const input = parseInput({ title, url, body, pinned: false, archived: false, color: "default" });
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);

  const images = form.getAll("image");
  if (images.length > 1) return json({ error: "画像は1枚だけ選んでください。" }, 400);
  const image = images[0];
  let imageBytes: Uint8Array | null = null;
  let filename = "";
  let mime = "";
  if (image !== undefined) {
    if (!(image instanceof File)) return json({ error: "画像を確認してください。" }, 400);
    mime = image.type.toLowerCase();
    filename = image.name.trim();
    if (!IMAGE_TYPES.has(mime)) return json({ error: "対応していない画像形式です。" }, 415);
    if (!validFilename(filename)) return json({ error: "ファイル名を確認してください。" }, 400);
    if (!image.size) return json({ error: "画像が空です。" }, 400);
    if (image.size > MAX_IMAGE_BYTES) return json({ error: "画像は20MB以下にしてください。" }, 413);
    imageBytes = new Uint8Array(await image.arrayBuffer());
  }

  const note = await insertNote(input, env);
  if (imageBytes) {
    try {
      note.attachments.push(await persistAttachment(note.id, filename, mime, imageBytes, env));
    } catch (error) {
      await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(note.id).run();
      throw error;
    }
  }
  return json({ note }, 201);
}

async function getAttachment(noteId: string, attachmentId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key, mime_type, filename FROM attachments WHERE id = ? AND note_id = ?",
  ).bind(attachmentId, noteId).first<Pick<AttachmentRow, "r2_key" | "mime_type" | "filename">>();
  if (!row) return json({ error: "画像が見つかりません。" }, 404);
  const object = await env.IMAGES.get(row.r2_key);
  if (!object || !("body" in object)) return json({ error: "画像が見つかりません。" }, 404);
  const headers = new Headers({
    "Content-Type": IMAGE_TYPES.has(row.mime_type) ? row.mime_type : "application/octet-stream",
    "Content-Length": String(object.size),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "ETag": object.httpEtag,
  });
  if (!IMAGE_TYPES.has(row.mime_type)) {
    const encoded = encodeURIComponent(row.filename).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`);
  }
  return new Response(object.body, { headers });
}

async function deleteAttachment(noteId: string, attachmentId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT a.r2_key FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.id = ? AND a.note_id = ? AND n.deleted_at IS NULL",
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

    try {
      if (url.pathname === "/api/capture" && request.method === "POST") {
        return await captureNote(request, env);
      }

      if (url.pathname === "/api/link-preview" && request.method === "GET") {
        return await linkPreview(request);
      }

      if (request.method !== "GET") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "この操作は許可されていません。" }, 403);
      }

      if (url.pathname === "/api/notes") {
        if (request.method === "GET") return await listNotes(request, env);
        if (request.method === "POST") return await createNote(request, env);
      }

      if (url.pathname === "/api/labels" && request.method === "GET") {
        return await listLabels(env);
      }

      if (url.pathname === "/api/export/counts" && request.method === "GET") {
        return await exportCounts(env);
      }

      if (url.pathname === "/api/import/keep" && request.method === "POST") {
        return await importKeepNote(request, env);
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

      const restoreMatch = /^\/api\/notes\/([0-9a-f-]{36})\/restore$/.exec(url.pathname);
      if (restoreMatch && request.method === "POST") {
        return await restoreNote(restoreMatch[1], env);
      }

      const permanentMatch = /^\/api\/notes\/([0-9a-f-]{36})\/permanent$/.exec(url.pathname);
      if (permanentMatch && request.method === "DELETE") {
        return await permanentlyDeleteNote(permanentMatch[1], env);
      }

      const match = /^\/api\/notes\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match) {
        if (request.method === "PATCH") return await updateNote(match[1], request, env);
        if (request.method === "DELETE") return await moveToTrash(match[1], env);
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
