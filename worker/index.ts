import { NOTE_COLORS } from "../src/types";
import { linkPreview } from "./linkPreview";
import type { Attachment, ChecklistItem, Note, NoteColor, NoteInput, NotePreview } from "../src/types";

interface NoteRow extends NotePreview {
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

const SELECT_NOTE = "SELECT id, title, body, url, pinned, archived, color, deleted_at, created_at, updated_at, preview_title, preview_description, preview_image, preview_hostname FROM notes";
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
  const preview: NotePreview = { preview_title: "", preview_description: "", preview_image: "", preview_hostname: "" };
  const limits = { preview_title: 300, preview_description: 500, preview_image: 2000, preview_hostname: 255 };
  for (const field of Object.keys(limits) as Array<keyof NotePreview>) {
    const value = input[field] === undefined ? current?.[field] ?? "" : input[field];
    if (typeof value !== "string" || value.length > limits[field]) return null;
    preview[field] = value.trim();
  }
  if (preview.preview_image) {
    try {
      if (!["http:", "https:"].includes(new URL(preview.preview_image).protocol)) return null;
    } catch { return null; }
  }
  if (!url || (current && current.url !== url)) {
    for (const field of Object.keys(preview) as Array<keyof NotePreview>) preview[field] = "";
  } else if (Object.values(preview).some(Boolean)) {
    preview.preview_hostname = new URL(url).hostname;
  }
  return { title, body, url, pinned, archived, color: color as NoteColor, checklist, labels, ...preview };
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

  const conditions = view === "trash" ? ["deleted_at IS NOT NULL"]
    : label ? ["deleted_at IS NULL"] : ["deleted_at IS NULL", "archived = ?"];
  const bindings: (string | number)[] = view === "trash" || label ? [] : [view === "archived" ? 1 : 0];
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

async function deleteLabels(request: Request, env: Env): Promise<Response> {
  const value = await readInput(request, 20_000);
  if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "ラベルの指定が正しくありません。" }, 400);
  const labels = (value as Record<string, unknown>).labels;
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_LABELS) {
    return json({ error: "削除するラベルを1〜50件指定してください。" }, 400);
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of labels) {
    if (typeof value !== "string") return json({ error: "ラベルの指定が正しくありません。" }, 400);
    const name = value.trim().normalize("NFC");
    const key = labelKey(name);
    if (!name || name.length > 100 || seen.has(key)) return json({ error: "ラベルの指定が正しくありません。" }, 400);
    keys.push(key);
    seen.add(key);
  }
  const placeholders = keys.map(() => "?").join(",");
  const result = await env.DB.prepare(`DELETE FROM labels WHERE name_key IN (${placeholders}) RETURNING name_key`).bind(...keys).all<{ name_key: string }>();
  return json({ deleted: result.results.length });
}

async function exportCounts(env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM attachments) AS attachments",
  ).first<{ notes: number; attachments: number }>();
  return json({ notes: counts?.notes ?? 0, attachments: counts?.attachments ?? 0 });
}

function relationStatements(noteId: string, input: NoteInput, env: Env, replace: boolean, existingLabelsOnly = false): D1PreparedStatement[] {
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
      if (!existingLabelsOnly) {
        statements.push(env.DB.prepare(`INSERT OR IGNORE INTO labels (name_key, name) VALUES ${placeholders}`)
          .bind(...input.labels.flatMap((name) => [labelKey(name), name])));
      }
      statements.push(env.DB.prepare(`INSERT INTO note_labels (note_id, label_key) VALUES ${placeholders}`)
        .bind(...input.labels.flatMap((name) => [noteId, labelKey(name)])));
    }
  }
  return statements;
}

async function insertNote(input: NoteInput, env: Env, timestamps?: { created_at: string; updated_at: string }, deletedAt: string | null = null, existingLabelsOnly = false): Promise<Note> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const createdAt = timestamps?.created_at ?? now;
  const updatedAt = timestamps?.updated_at ?? now;
  const statements = [env.DB.prepare(
    "INSERT INTO notes (id, title, body, url, pinned, archived, color, deleted_at, created_at, updated_at, preview_title, preview_description, preview_image, preview_hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, input.title, input.body, input.url, Number(input.pinned), Number(input.archived), input.color, deletedAt, createdAt, updatedAt,
    input.preview_title ?? "", input.preview_description ?? "", input.preview_image ?? "", input.preview_hostname ?? ""),
  ...relationStatements(id, input, env, false, existingLabelsOnly)];
  await env.DB.batch(statements);
  const row = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  return (await withRelations([row!], env))[0];
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const input = parseInput(await readInput(request));
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);
  return json({ note: await insertNote(input, env) }, 201);
}

async function getNote(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  if (!row) return json({ error: "メモが見つかりません。" }, 404);
  return json({ note: (await withRelations([row], env))[0] });
}

async function importKeepNote(request: Request, env: Env): Promise<Response> {
  const value = await readInput(request, MAX_IMPORT_BYTES);
  const input = parseInput(value, undefined, true);
  if (!input || !value || typeof value !== "object" || Array.isArray(value)) {
    return json({ error: "インポートするメモを確認してください。" }, 400);
  }
  const { created_at, updated_at, isTrashed } = value as Record<string, unknown>;
  if (isTrashed !== undefined && typeof isTrashed !== "boolean") return json({ error: "ゴミ箱の指定が正しくありません。" }, 400);
  if (typeof created_at !== "string" || typeof updated_at !== "string"
    || !Number.isFinite(Date.parse(created_at)) || !Number.isFinite(Date.parse(updated_at))
    || new Date(created_at).toISOString() !== created_at || new Date(updated_at).toISOString() !== updated_at) {
    return json({ error: "日時を確認してください。" }, 400);
  }
  return json({ note: await insertNote(input, env, { created_at, updated_at }, isTrashed ? new Date().toISOString() : null) }, 201);
}

async function updateNote(id: string, request: Request, env: Env): Promise<Response> {
  const current = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ? AND deleted_at IS NULL`).bind(id).first<NoteRow>();
  if (!current) return json({ error: "メモが見つかりません。" }, 404);
  const input = parseInput(await readInput(request), current);
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);

  const now = new Date().toISOString();
  await env.DB.batch([env.DB.prepare(
    "UPDATE notes SET title = ?, body = ?, url = ?, pinned = ?, archived = ?, color = ?, updated_at = ?, preview_title = ?, preview_description = ?, preview_image = ?, preview_hostname = ? WHERE id = ? AND deleted_at IS NULL",
  ).bind(input.title, input.body, input.url, Number(input.pinned), Number(input.archived), input.color, now,
    input.preview_title, input.preview_description, input.preview_image, input.preview_hostname, id),
  ...relationStatements(id, input, env, true)]);
  const row = await env.DB.prepare(`${SELECT_NOTE} WHERE id = ?`).bind(id).first<NoteRow>();
  return json({ note: (await withRelations([row!], env))[0] });
}

async function moveToTrash(id: string, request: Request, env: Env): Promise<Response> {
  const now = new Date().toISOString();
  let deletedAt = now;
  // 復元のUndoでは元のゴミ箱日時を戻し、30日の削除期限を維持する。
  const bytes = request.body ? await readBytes(request, MAX_REQUEST_BYTES) : new Uint8Array();
  if (bytes.byteLength > 0) {
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new Error("invalid_json"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "ゴミ箱日時を確認してください。" }, 400);
    const value = (input as Record<string, unknown>).deleted_at;
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp) || timestamp > Date.now() || new Date(timestamp).toISOString() !== value) {
      return json({ error: "ゴミ箱日時を確認してください。" }, 400);
    }
    deletedAt = value as string;
  }
  const result = await env.DB.prepare(
    "UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  ).bind(deletedAt, now, id).run();
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

async function deleteTrashedNote(id: string, env: Env, cutoff?: string): Promise<boolean> {
  const condition = cutoff ? " AND deleted_at <= ?" : "";
  const bindings = cutoff ? [id, cutoff] : [id];
  const note = await env.DB.prepare(`SELECT id FROM notes WHERE id = ? AND deleted_at IS NOT NULL${condition}`).bind(...bindings).first();
  if (!note) return false;
  const attachmentsResult = await env.DB.prepare("SELECT r2_key FROM attachments WHERE note_id = ?").bind(id).all<{ r2_key: string }>();
  const keys = (attachmentsResult.results ?? []).map((row) => row.r2_key);
  for (let index = 0; index < keys.length; index += 1000) {
    await env.IMAGES.delete(keys.slice(index, index + 1000));
  }
  const result = await env.DB.prepare(`DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL${condition}`).bind(...bindings).run();
  return result.meta.changes > 0;
}

async function permanentlyDeleteNote(id: string, env: Env): Promise<Response> {
  if (!await deleteTrashedNote(id, env)) return json({ error: "メモが見つかりません。" }, 404);
  return json({ ok: true });
}

async function purgeOldTrash(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let afterId = "";
  while (true) {
    const result = await env.DB.prepare(
      "SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND id > ? ORDER BY id LIMIT 50",
    ).bind(cutoff, afterId).all<{ id: string }>();
    const rows = result.results ?? [];
    for (const row of rows) {
      afterId = row.id;
      try {
        await deleteTrashedNote(row.id, env, cutoff);
      } catch (error) {
        console.error("trash_purge_note_failed", row.id, error);
      }
    }
    if (rows.length < 50) break;
  }
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
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(noteId).first();
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

async function captureApi(request: Request, env: Env): Promise<Response> {
  const secret = (env as Env & { CAPTURE_API_KEY?: string }).CAPTURE_API_KEY;
  if (!secret) return json({ error: "保存APIが設定されていません。" }, 503);
  if (!await matchesApiKey(request.headers.get("Authorization"), secret)) {
    return json({ error: "API KEYが正しくありません。" }, 401);
  }
  if (request.method === "GET") return listLabels(env);
  if (request.method === "POST") return captureNote(request, env);
  return json({ error: "このメソッドには対応していません。" }, 405);
}

async function captureNote(request: Request, env: Env): Promise<Response> {
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
  let labels: unknown = [];
  if (form.has("labels")) {
    const value = form.get("labels");
    if (typeof value !== "string" || value.length > 20_000) return json({ error: "ラベルを確認してください。" }, 400);
    try { labels = JSON.parse(value); } catch { return json({ error: "ラベルを確認してください。" }, 400); }
  }
  const input = parseInput({ title, url, body, pinned: false, archived: false, color: "default", labels,
    preview_title: form.get("preview_title") ?? "",
    preview_description: form.get("preview_description") ?? "",
    preview_image: form.get("preview_image") ?? "",
    preview_hostname: form.get("preview_hostname") ?? "",
  });
  if (!input) return json({ error: "メモの内容を確認してください。" }, 400);
  if (input.labels?.length) {
    const keys = input.labels.map(labelKey);
    const result = await env.DB.prepare(`SELECT name_key FROM labels WHERE name_key IN (${keys.map(() => "?").join(",")})`)
      .bind(...keys).all<{ name_key: string }>();
    if ((result.results ?? []).length !== keys.length) return json({ error: "登録済みのラベルだけを選択してください。" }, 400);
  }

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

  const note = await insertNote(input, env, undefined, null, true);
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
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await purgeOldTrash(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "見つかりません。" }, 404);

    try {
      if (url.pathname === "/api/capture") {
        return await captureApi(request, env);
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

      if (url.pathname === "/api/labels") {
        if (request.method === "GET") return await listLabels(env);
        if (request.method === "DELETE") return await deleteLabels(request, env);
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
        if (request.method === "GET") return await getNote(match[1], env);
        if (request.method === "PATCH") return await updateNote(match[1], request, env);
        if (request.method === "DELETE") return await moveToTrash(match[1], request, env);
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
