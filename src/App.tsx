import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Attachment, Note, NoteInput } from "./types";

type View = "active" | "archived";
type NoteList = { notes: Note[]; hasMore: boolean };

const emptyNote: NoteInput = { title: "", body: "", url: "", pinned: false, archived: false };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

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
  const [notes, setNotes] = useState<Note[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteInput | null>(null);
  const [editorAttachments, setEditorAttachments] = useState<Attachment[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotes([]);
    setHasMore(false);
    setError("");
    api<NoteList>(`/api/notes?view=${view}&offset=0`, { signal: controller.signal })
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
  }, [view, reload]);

  function openEditor(note?: Note) {
    setError("");
    setEditingId(note?.id ?? null);
    setEditorAttachments(note?.attachments ?? []);
    setDraft(note
      ? { title: note.title, body: note.body, url: note.url, pinned: note.pinned, archived: note.archived }
      : { ...emptyNote, archived: view === "archived" });
  }

  async function loadMore() {
    setLoading(true);
    setError("");
    try {
      const data = await api<NoteList>(`/api/notes?view=${view}&offset=${notes.length}`);
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
      if (editingId) {
        await api(`/api/notes/${editingId}`, { method: "PATCH", body: JSON.stringify(draft) });
      } else {
        await api("/api/notes", { method: "POST", body: JSON.stringify(draft) });
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
    if (!editingId || working || !window.confirm("このメモを完全に削除しますか？")) return;
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

  return (
    <main className="app">
      <header className="topbar">
        <h1>MyKeep</h1>
        <button className="primary" onClick={() => openEditor()}>＋ 新規メモ</button>
      </header>

      <nav className="tabs" aria-label="メモの表示">
        <button className={view === "active" ? "selected" : ""} onClick={() => setView("active")}>メモ</button>
        <button className={view === "archived" ? "selected" : ""} onClick={() => setView("archived")}>アーカイブ</button>
      </nav>

      {error && !draft && <p className="error" role="alert">{error}</p>}
      {!loading && notes.length === 0 && <p className="empty">{view === "active" ? "メモはまだありません。" : "アーカイブはありません。"}</p>}

      <section className="grid" aria-label={view === "active" ? "メモ一覧" : "アーカイブ一覧"}>
        {notes.map((note) => (
          <article className="card" key={note.id}>
            <button className="card-content" onClick={() => openEditor(note)} aria-label={`${note.title || "無題のメモ"}を編集`}>
              {note.pinned && <span className="pin-label">📌 ピン留め</span>}
              {note.title && <strong>{note.title}</strong>}
              {note.body && <span className="body-preview">{note.body}</span>}
              {note.attachments.length > 0 && (
                <span className="card-photo">
                  <img src={note.attachments[0].url} alt="" loading="lazy" />
                  {note.attachments.length > 1 && <span className="photo-count">+{note.attachments.length - 1}</span>}
                </span>
              )}
            </button>
            {note.url && <a className="note-link" href={note.url} target="_blank" rel="noopener noreferrer">{note.url}</a>}
            <div className="card-actions">
              <button disabled={working} onClick={() => updateFlag(note, "pinned")}>{note.pinned ? "ピン解除" : "ピン留め"}</button>
              <button disabled={working} onClick={() => updateFlag(note, "archived")}>{note.archived ? "戻す" : "アーカイブ"}</button>
            </div>
          </article>
        ))}
      </section>

      {loading && <p className="status">読み込み中…</p>}
      {hasMore && !loading && <button className="more" onClick={loadMore}>続きを読み込む</button>}

      {draft && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setDraft(null); }}>
          <form className="editor" onSubmit={save} aria-label={editingId ? "メモを編集" : "新規メモ"}>
            <div className="editor-heading">
              <h2>{editingId ? "メモを編集" : "新規メモ"}</h2>
              <button type="button" className="close" onClick={() => setDraft(null)} disabled={working} aria-label="閉じる">×</button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <label>タイトル<input value={draft.title} maxLength={300} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>本文<textarea value={draft.body} maxLength={100000} rows={9} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
            <label>URL<input type="url" value={draft.url} maxLength={2000} placeholder="https://" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
            <div className="editor-options">
              <label><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} /> ピン留め</label>
              <label><input type="checkbox" checked={draft.archived} onChange={(event) => setDraft({ ...draft, archived: event.target.checked })} /> アーカイブ</label>
            </div>
            {editingId ? (
              <section className="image-section" aria-label="添付画像">
                <label className="upload-label">画像を追加
                  <input type="file" accept={IMAGE_TYPES.join(",")} multiple onChange={addImages} disabled={working} />
                </label>
                {editorAttachments.length > 0 && (
                  <div className="editor-images">
                    {editorAttachments.map((attachment) => (
                      <div className="editor-image" key={attachment.id}>
                        <img src={attachment.url} alt={attachment.filename} loading="lazy" />
                        <button type="button" onClick={() => removeImage(attachment)} disabled={working} aria-label={`${attachment.filename}を削除`}>削除</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : <p className="image-hint">画像はメモを保存してから追加できます。</p>}
            <div className="editor-actions">
              {editingId && <button type="button" className="danger" onClick={remove} disabled={working}>削除</button>}
              <button type="submit" className="primary" disabled={working || !(draft.title.trim() || draft.body.trim() || draft.url.trim())}>{working ? "保存中…" : "保存"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
