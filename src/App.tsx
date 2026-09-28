import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { readKeepZip } from "./keepImport";
import type { KeepZipResult } from "./keepImport";
import { NOTE_COLORS } from "./types";
import type { Attachment, ChecklistInput, Note, NoteColor, NoteInput } from "./types";

type View = "active" | "archived" | "trash";
type NoteList = { notes: Note[]; hasMore: boolean };
type ImportCounts = { done: number; total: number; success: number; failed: number; skipped: number };
type ImportProgress = { notes: ImportCounts; attachments: ImportCounts };
type NoteDraft = NoteInput & { checklist: ChecklistInput[] };

const emptyNote: NoteDraft = { title: "", body: "", url: "", pinned: false, archived: false, color: "default", checklist: [] };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const COLOR_LABELS: Record<NoteColor, string> = {
  default: "なし", red: "赤", orange: "オレンジ", yellow: "黄", green: "緑", blue: "青", purple: "紫",
};

function listPath(view: View, search: string, label: string, offset: number): string {
  const params = new URLSearchParams({ view, offset: String(offset) });
  if (search.trim()) params.set("q", search.trim());
  if (label) params.set("label", label);
  return `/api/notes?${params}`;
}

function notePreview(note: Note) {
  const imageAttachments = note.attachments.filter((item) => IMAGE_TYPES.includes(item.mime_type));
  return <>
    {note.pinned && <span className="pin-label">📌 ピン留め</span>}
    {note.title && <strong>{note.title}</strong>}
    {note.body && <span className="body-preview">{note.body}</span>}
    {note.checklist.length > 0 && <span className="checklist-preview">
      {note.checklist.map((item) => <span className={item.checked ? "checked" : ""} key={item.id}>
        {item.checked ? "☑" : "☐"} {item.text}
      </span>)}
    </span>}
    {note.labels.length > 0 && <span className="label-list">
      {note.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}
    </span>}
    {imageAttachments.length > 0 && (
      <span className="card-photo">
        <img src={imageAttachments[0].url} alt="" loading="lazy" />
        {imageAttachments.length > 1 && <span className="photo-count">+{imageAttachments.length - 1}</span>}
      </span>
    )}
    {note.attachments.length > imageAttachments.length && <span className="pin-label">📎 添付ファイル {note.attachments.length - imageAttachments.length}件</span>}
  </>;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
  });
  let data: T & { error?: string };
  try {
    data = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error("応答を読み取れませんでした。ページを再読み込みしてください。");
  }
  if (!response.ok) throw new Error(data.error ?? "処理に失敗しました。");
  return data;
}

export default function App() {
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [labelText, setLabelText] = useState("");
  const [editorAttachments, setEditorAttachments] = useState<Attachment[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotes([]);
    setHasMore(false);
    setError("");
    api<NoteList>(listPath(view, search, labelFilter, 0), { signal: controller.signal })
      .then((data) => {
        setNotes(data.notes);
        setHasMore(data.hasMore);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "読み込みに失敗しました。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [view, search, labelFilter, reload]);

  useEffect(() => {
    api<{ labels: string[] }>("/api/labels")
      .then((data) => {
        setAvailableLabels(data.labels);
        setLabelFilter((current) => current && !data.labels.includes(current) ? "" : current);
      })
      .catch(() => setAvailableLabels([]));
  }, [reload]);

  function openEditor(note?: Note) {
    setError("");
    setEditingId(note?.id ?? null);
    setEditorAttachments(note?.attachments ?? []);
    setLabelText(note?.labels.join("\n") ?? "");
    setDraft(note
      ? { title: note.title, body: note.body, url: note.url, pinned: note.pinned, archived: note.archived, color: note.color,
        checklist: note.checklist.map(({ text, checked }) => ({ text, checked })) }
      : { ...emptyNote, archived: view === "archived" });
  }

  async function loadMore() {
    setLoading(true);
    setError("");
    try {
      const data = await api<NoteList>(listPath(view, search, labelFilter, notes.length));
      setNotes((current) => [...current, ...data.notes]);
      setHasMore(data.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || working) return;
    setWorking(true);
    setError("");
    try {
      const labels = labelText.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      const input = { ...draft, labels };
      if (editingId) {
        await api(`/api/notes/${editingId}`, { method: "PATCH", body: JSON.stringify(input) });
      } else {
        await api("/api/notes", { method: "POST", body: JSON.stringify(input) });
      }
      setDraft(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function updateFlag(note: Note, field: "pinned" | "archived") {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !note[field] }) });
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    if (!editingId || working || !window.confirm("このメモをゴミ箱に移動しますか？")) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${editingId}`, { method: "DELETE" });
      setDraft(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "削除に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function restore(note: Note) {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${note.id}/restore`, { method: "POST" });
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "復元に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyRemove(note: Note) {
    if (working || !window.confirm("このメモと添付画像を完全に削除しますか？元に戻せません。")) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${note.id}/permanent`, { method: "DELETE" });
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "完全削除に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function addImages(event: ChangeEvent<HTMLInputElement>) {
    if (!editingId || working) return;
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (files.some((file) => !IMAGE_TYPES.includes(file.type))) {
      setError("JPEG・PNG・WebP・GIF・AVIF の画像を選んでください。");
      return;
    }
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
      setError("画像は1枚20MB以下にしてください。");
      return;
    }

    setWorking(true);
    setError("");
    try {
      for (const file of files) {
        const { attachment } = await api<{ attachment: Attachment }>(`/api/notes/${editingId}/attachments`, {
          method: "POST",
          body: file,
          headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) },
        });
        setEditorAttachments((current) => [...current, attachment]);
        setNotes((current) => current.map((note) => note.id === editingId
          ? { ...note, attachments: [...note.attachments, attachment] }
          : note));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "画像の追加に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function removeImage(attachment: Attachment) {
    if (!editingId || working || !window.confirm("この画像を削除しますか？")) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${editingId}/attachments/${attachment.id}`, { method: "DELETE" });
      setEditorAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setNotes((current) => current.map((note) => note.id === editingId
        ? { ...note, attachments: note.attachments.filter((item) => item.id !== attachment.id) }
        : note));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "画像の削除に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function importZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || importing) return;
    setImporting(true);
    setImportMessage("ZIPを解析中…");
    setImportProgress(null);
    let extracted: KeepZipResult | null = null;
    try {
      extracted = await readKeepZip(file);
      const progress: ImportProgress = {
        notes: { done: extracted.failed + extracted.skipped, total: extracted.total,
          success: 0, failed: extracted.failed, skipped: extracted.skipped },
        attachments: { done: 0, total: extracted.attachmentTotal, success: 0, failed: 0, skipped: 0 },
      };
      setImportProgress({ notes: { ...progress.notes }, attachments: { ...progress.attachments } });
      setImportMessage("インポート中…");
      for (const record of extracted.notes) {
        let noteId: string | null = null;
        try {
          const { note } = await api<{ note: Note }>("/api/import/keep", { method: "POST", body: JSON.stringify(record.note) });
          noteId = note.id;
          progress.notes.success += 1;
        } catch {
          progress.notes.failed += 1;
        }
        if (noteId) {
          for (const reference of record.attachments) {
            try {
              const attachment = await extracted.readAttachment(record.sourcePath, reference);
              if (!attachment) progress.attachments.skipped += 1;
              else {
                await api(`/api/notes/${noteId}/attachments`, {
                  method: "POST",
                  body: attachment.blob,
                  headers: { "Content-Type": attachment.mime, "X-File-Name": encodeURIComponent(attachment.filename) },
                });
                progress.attachments.success += 1;
              }
            } catch {
              progress.attachments.failed += 1;
            }
            progress.attachments.done += 1;
            setImportProgress({ notes: { ...progress.notes }, attachments: { ...progress.attachments } });
          }
        } else {
          progress.attachments.skipped += record.attachments.length;
          progress.attachments.done += record.attachments.length;
        }
        progress.notes.done += 1;
        setImportProgress({ notes: { ...progress.notes }, attachments: { ...progress.attachments } });
      }
      setImportMessage("インポート完了");
      setReload((value) => value + 1);
    } catch (cause) {
      setImportMessage(cause instanceof Error ? cause.message : "インポートに失敗しました。");
    } finally {
      try {
        if (extracted) await extracted.close();
      } catch {
        // 読み取りは終わっているため、画面の操作を戻す。
      }
      setImporting(false);
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>MyKeep</h1>
        {view !== "trash" && <button className="primary" onClick={() => openEditor()}>＋ 新規メモ</button>}
      </header>

      <div className="browse-bar">
        <nav className="tabs" aria-label="メモの表示">
          <button className={view === "active" ? "selected" : ""} onClick={() => setView("active")}>メモ</button>
          <button className={view === "archived" ? "selected" : ""} onClick={() => setView("archived")}>アーカイブ</button>
          <button className={view === "trash" ? "selected" : ""} onClick={() => setView("trash")}>ゴミ箱</button>
        </nav>
        <label className="search-field">検索
          <input type="search" value={search} maxLength={200} placeholder="タイトル・本文・URL" onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className="label-filter">ラベル
          <select value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}>
            <option value="">すべて</option>
            {availableLabels.map((name) => <option value={name} key={name}>{name}</option>)}
          </select>
        </label>
      </div>

      <details className="import-panel">
        <summary>Google Keep Import</summary>
        <div className="import-content">
          <label>Takeout ZIPを選択
            <input type="file" accept=".zip,application/zip" onChange={importZip} disabled={importing} />
          </label>
          {importMessage && <p role="status">{importMessage}</p>}
          {importProgress && <p>メモ: {importProgress.notes.done} / {importProgress.notes.total}<br />
            成功 {importProgress.notes.success}　失敗 {importProgress.notes.failed}　スキップ {importProgress.notes.skipped}<br />
            画像・添付: {importProgress.attachments.done} / {importProgress.attachments.total}<br />
            成功 {importProgress.attachments.success}　失敗 {importProgress.attachments.failed}　スキップ {importProgress.attachments.skipped}</p>}
        </div>
      </details>

      {error && !draft && <p className="error" role="alert">{error}</p>}
      {!loading && notes.length === 0 && <p className="empty">{search.trim() || labelFilter ? "該当するメモはありません。" : view === "active" ? "メモはまだありません。" : view === "archived" ? "アーカイブはありません。" : "ゴミ箱は空です。"}</p>}

      <section className="grid" aria-label={view === "active" ? "メモ一覧" : view === "archived" ? "アーカイブ一覧" : "ゴミ箱一覧"}>
        {notes.map((note) => (
          <article className="card" data-color={note.color} key={note.id}>
            {view === "trash"
              ? <div className="card-content">{notePreview(note)}</div>
              : <button className="card-content" onClick={() => openEditor(note)} aria-label={`${note.title || "無題のメモ"}を編集`}>{notePreview(note)}</button>}
            {note.url && <a className="note-link" href={note.url} target="_blank" rel="noopener noreferrer">{note.url}</a>}
            <div className="card-actions">
              {view === "trash" ? <>
                <button disabled={working} onClick={() => restore(note)}>復元</button>
                <button className="danger" disabled={working} onClick={() => permanentlyRemove(note)}>完全削除</button>
              </> : <>
                <button disabled={working} onClick={() => updateFlag(note, "pinned")}>{note.pinned ? "ピン解除" : "ピン留め"}</button>
                <button disabled={working} onClick={() => updateFlag(note, "archived")}>{note.archived ? "戻す" : "アーカイブ"}</button>
              </>}
            </div>
          </article>
        ))}
      </section>

      {loading && <p className="status">読み込み中…</p>}
      {hasMore && !loading && <button className="more" onClick={loadMore}>続きを読み込む</button>}

      {draft && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setDraft(null); }}>
          <form className="editor" data-color={draft.color} onSubmit={save} aria-label={editingId ? "メモを編集" : "新規メモ"}>
            <div className="editor-heading">
              <h2>{editingId ? "メモを編集" : "新規メモ"}</h2>
              <button type="button" className="close" onClick={() => setDraft(null)} disabled={working} aria-label="閉じる">×</button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <label>タイトル<input value={draft.title} maxLength={300} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>本文<textarea value={draft.body} maxLength={100000} rows={9} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
            <section className="checklist-editor" aria-label="チェックリスト">
              <div className="section-heading"><strong>チェックリスト</strong>
                <button type="button" onClick={() => setDraft({ ...draft, checklist: [...draft.checklist, { text: "", checked: false }] })} disabled={draft.checklist.length >= 500}>＋ 項目を追加</button>
              </div>
              {draft.checklist.map((item, index) => <div className="checklist-row" key={index}>
                <input type="checkbox" checked={item.checked} aria-label={`${index + 1}番目の項目をチェック`}
                  onChange={(event) => setDraft({ ...draft, checklist: draft.checklist.map((entry, position) => position === index ? { ...entry, checked: event.target.checked } : entry) })} />
                <input value={item.text} maxLength={10000} aria-label={`${index + 1}番目の項目`} placeholder="項目"
                  onChange={(event) => setDraft({ ...draft, checklist: draft.checklist.map((entry, position) => position === index ? { ...entry, text: event.target.value } : entry) })} />
                <button type="button" aria-label={`${index + 1}番目の項目を削除`}
                  onClick={() => setDraft({ ...draft, checklist: draft.checklist.filter((_, position) => position !== index) })}>削除</button>
              </div>)}
            </section>
            <label>ラベル（1行に1件）<textarea value={labelText} rows={2} onChange={(event) => setLabelText(event.target.value)} placeholder="仕事" /></label>
            <label>URL<input type="url" value={draft.url} maxLength={2000} placeholder="https://" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
            <label>色<select value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value as NoteColor })}>
              {NOTE_COLORS.map((color) => <option value={color} key={color}>{COLOR_LABELS[color]}</option>)}
            </select></label>
            <div className="editor-options">
              <label><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} /> ピン留め</label>
              <label><input type="checkbox" checked={draft.archived} onChange={(event) => setDraft({ ...draft, archived: event.target.checked })} /> アーカイブ</label>
            </div>
            {editingId ? (
              <section className="image-section" aria-label="添付ファイル">
                <label className="upload-label">画像を追加
                  <input type="file" accept={IMAGE_TYPES.join(",")} multiple onChange={addImages} disabled={working} />
                </label>
                {editorAttachments.length > 0 && (
                  <div className="editor-images">
                    {editorAttachments.map((attachment) => (
                      <div className="editor-image" key={attachment.id}>
                        {IMAGE_TYPES.includes(attachment.mime_type)
                          ? <img src={attachment.url} alt={attachment.filename} loading="lazy" />
                          : <a href={attachment.url} download={attachment.filename}>{attachment.filename}</a>}
                        <button type="button" onClick={() => removeImage(attachment)} disabled={working} aria-label={`${attachment.filename}を削除`}>削除</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : <p className="image-hint">画像はメモを保存してから追加できます。</p>}
            <div className="editor-actions">
              {editingId && <button type="button" className="danger" onClick={remove} disabled={working}>ゴミ箱へ</button>}
              <button type="submit" className="primary" disabled={working || !(editingId || draft.title.trim() || draft.body.trim() || draft.url.trim() || draft.checklist.length)}>{working ? "保存中…" : "保存"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
