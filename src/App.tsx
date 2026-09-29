import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent } from "react";
import { BlobWriter } from "@zip.js/zip.js";
import { backupFileName, createBackup } from "./exportBackup";
import type { BackupProgress, BackupResult } from "./exportBackup";
import { readKeepZip } from "./keepImport";
import type { KeepZipResult } from "./keepImport";
import { getLinkPreview } from "./linkPreview";
import type { LinkPreview } from "./linkPreview";
import { NOTE_COLORS } from "./types";
import type { Attachment, ChecklistInput, Note, NoteColor, NoteInput } from "./types";

type View = "active" | "archived" | "trash";
type NoteList = { notes: Note[]; hasMore: boolean };
type ImportCounts = { done: number; total: number; success: number; failed: number; skipped: number };
type ImportProgress = { notes: ImportCounts & { trashed: number }; attachments: ImportCounts };
type NoteDraft = NoteInput & { checklist: ChecklistInput[] };
type PendingImage = { id: string; file: File; previewUrl: string };

const emptyNote: NoteDraft = { title: "", body: "", url: "", pinned: false, archived: false, color: "default", checklist: [] };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
};
const COLOR_LABELS: Record<NoteColor, string> = {
  default: "なし", red: "赤", orange: "オレンジ", yellow: "黄", green: "緑", blue: "青", purple: "紫",
};
const PREVIEW_SETTING = "mykeep.richLinkPreview";
const DARK_SETTING = "mykeep.darkMode";

function labelKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

function savedSetting(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function firstPageChanged(current: Note[], next: NoteList): boolean {
  const first = current.slice(0, 50);
  return first.length !== next.notes.length
    || first.some((note, index) => note.id !== next.notes[index].id || note.updated_at !== next.notes[index].updated_at);
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [editorAttachments, setEditorAttachments] = useState<Attachment[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [draggingImage, setDraggingImage] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<BackupProgress | null>(null);
  const [exportResult, setExportResult] = useState<BackupResult | null>(null);
  const [exportMessage, setExportMessage] = useState("");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  const [labelsToDelete, setLabelsToDelete] = useState<string[]>([]);
  const [labelDeleteConfirm, setLabelDeleteConfirm] = useState(false);
  const [deletingLabels, setDeletingLabels] = useState(false);
  const [labelDeleteError, setLabelDeleteError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [richLinkPreview, setRichLinkPreview] = useState(() => savedSetting(PREVIEW_SETTING, true));
  const [darkMode, setDarkMode] = useState(() => savedSetting(DARK_SETTING, false));
  const [previews, setPreviews] = useState<Record<string, LinkPreview | null>>({});
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const notesRef = useRef(notes);
  const lastListPathRef = useRef("");
  const refreshingRef = useRef(false);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);
  useEffect(() => () => { pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    try {
      window.localStorage.setItem(DARK_SETTING, String(darkMode));
      window.localStorage.setItem(PREVIEW_SETTING, String(richLinkPreview));
    } catch { /* 保存できない環境でも画面内の設定は使える。 */ }
  }, [darkMode, richLinkPreview]);

  useEffect(() => {
    const controller = new AbortController();
    const path = listPath(view, search, labelFilter, 0);
    const changedFilter = path !== lastListPathRef.current;
    lastListPathRef.current = path;
    const pages = changedFilter ? 1 : Math.max(1, Math.ceil(notesRef.current.length / 50));
    refreshingRef.current = true;
    if (changedFilter) {
      setLoading(true);
      setNotes([]);
      setHasMore(false);
    }
    setError("");
    async function refresh() {
      try {
        const collected: Note[] = [];
        let more = false;
        for (let page = 0; page < pages; page++) {
          const data = await api<NoteList>(listPath(view, search, labelFilter, page * 50), { signal: controller.signal });
          collected.push(...data.notes);
          more = data.hasMore;
          if (!more) break;
        }
        if (!controller.signal.aborted) {
          setNotes(collected);
          setHasMore(more);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "読み込みに失敗しました。");
      } finally {
        if (!controller.signal.aborted) {
          refreshingRef.current = false;
          setLoading(false);
        }
      }
    }
    void refresh();
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

  useEffect(() => {
    let active = true;
    let checking = false;
    async function checkForNewNotes() {
      if (document.visibilityState !== "visible" || refreshingRef.current || checking) return;
      checking = true;
      try {
        const data = await api<NoteList>(listPath(view, search, labelFilter, 0));
        if (active && firstPageChanged(notesRef.current, data)) setReload((value) => value + 1);
      } catch { /* 自動確認の失敗は表示中の一覧に影響させない。 */ }
      finally { checking = false; }
    }
    const interval = window.setInterval(() => { void checkForNewNotes(); }, 10_000);
    const onFocus = () => { void checkForNewNotes(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void checkForNewNotes(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [view, search, labelFilter]);

  useEffect(() => {
    if (!richLinkPreview) return;
    let active = true;
    for (const url of new Set(notes.map((note) => note.url).filter(Boolean))) {
      void getLinkPreview(url).then((preview) => {
        if (active) setPreviews((current) => current[url] === preview ? current : { ...current, [url]: preview });
      });
    }
    return () => { active = false; };
  }, [notes, richLinkPreview]);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) setSettingsMenuOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [settingsMenuOpen]);

  useEffect(() => {
    if (!labelMenuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!labelMenuRef.current?.contains(event.target as Node)) setLabelMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [labelMenuOpen]);

  function clearPendingImages() {
    pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    pendingImagesRef.current = [];
    setPendingImages([]);
  }

  function closeEditor() {
    clearPendingImages();
    setDraft(null);
    setLabelMenuOpen(false);
    setCreatingLabel(false);
    setDraggingImage(false);
  }

  function openEditor(note?: Note) {
    setError("");
    clearPendingImages();
    setEditingId(note?.id ?? null);
    setEditorAttachments(note?.attachments ?? []);
    setSelectedLabels(note?.labels ?? []);
    setLabelMenuOpen(false);
    setCreatingLabel(false);
    setNewLabelName("");
    setDraft(note
      ? { title: note.title, body: note.body, url: note.url, pinned: note.pinned, archived: note.archived, color: note.color,
        checklist: note.checklist.map(({ text, checked }) => ({ text, checked })) }
      : { ...emptyNote, archived: view === "archived" });
  }

  function toggleLabel(name: string) {
    setSelectedLabels((current) => current.some((label) => labelKey(label) === labelKey(name))
      ? current.filter((label) => labelKey(label) !== labelKey(name))
      : current.length < 50 ? [...current, name] : current);
  }

  function addNewLabel() {
    const name = newLabelName.trim().normalize("NFC");
    if (!name || name.length > 100) {
      setError("ラベル名は1〜100文字で入力してください。");
      return;
    }
    const existing = [...availableLabels, ...selectedLabels].find((label) => labelKey(label) === labelKey(name));
    const selected = existing ?? name;
    if (!selectedLabels.some((label) => labelKey(label) === labelKey(selected))) {
      if (selectedLabels.length >= 50) {
        setError("ラベルは50件まで選択できます。");
        return;
      }
      setSelectedLabels((current) => [...current, selected]);
    }
    setNewLabelName("");
    setCreatingLabel(false);
    setError("");
  }

  function selectView(nextView: View) {
    setView(nextView);
    setLabelFilter("");
    setMenuOpen(false);
  }

  function selectLabel(name: string) {
    setView("active");
    setLabelFilter(name);
    setMenuOpen(false);
  }

  function closeLabelManager() {
    setLabelManagerOpen(false);
    setLabelsToDelete([]);
    setLabelDeleteConfirm(false);
    setLabelDeleteError("");
  }

  function openLabelManager() {
    setLabelsToDelete([]);
    setLabelDeleteConfirm(false);
    setLabelDeleteError("");
    setLabelManagerOpen(true);
    setMenuOpen(false);
  }

  function toggleLabelToDelete(name: string) {
    const key = labelKey(name);
    setLabelsToDelete((current) => current.includes(key)
      ? current.filter((selected) => selected !== key)
      : current.length < 50 ? [...current, key] : current);
  }

  async function deleteSelectedLabels() {
    const names = availableLabels.filter((name) => labelsToDelete.includes(labelKey(name)));
    if (!names.length || deletingLabels) return;
    setDeletingLabels(true);
    setLabelDeleteError("");
    try {
      await api<{ deleted: number }>("/api/labels", { method: "DELETE", body: JSON.stringify({ labels: names }) });
      setAvailableLabels((current) => current.filter((name) => !labelsToDelete.includes(labelKey(name))));
      if (labelsToDelete.includes(labelKey(labelFilter))) {
        setLabelFilter("");
        setView("active");
      }
      closeLabelManager();
      setReload((value) => value + 1);
    } catch (cause) {
      setLabelDeleteError(cause instanceof Error ? cause.message : "ラベルを削除できませんでした。");
    } finally {
      setDeletingLabels(false);
    }
  }

  function goHome() {
    setView("active");
    setLabelFilter("");
    setSearch("");
    setMenuOpen(false);
    setSettingsMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function refreshCurrent() {
    setReload((value) => value + 1);
  }

  async function loadMore() {
    if (refreshingRef.current || loading) return;
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
      const images = pendingImagesRef.current;
      const title = !editingId && !draft.title.trim() && !draft.body.trim() && !draft.url.trim()
        && !draft.checklist.some((item) => item.text.trim()) && images.length
        ? images[0].file.name.replace(/\.[^.]+$/, "") || "画像メモ" : draft.title;
      const input = { ...draft, title, labels: selectedLabels };
      const { note } = editingId
        ? await api<{ note: Note }>(`/api/notes/${editingId}`, { method: "PATCH", body: JSON.stringify(input) })
        : await api<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify(input) });
      if (!editingId) {
        setEditingId(note.id);
        setDraft((current) => current ? { ...current, title } : current);
      }
      const failed: PendingImage[] = [];
      for (const image of images) {
        try {
          const { attachment } = await api<{ attachment: Attachment }>(`/api/notes/${note.id}/attachments`, {
            method: "POST", body: image.file,
            headers: { "Content-Type": image.file.type, "X-File-Name": encodeURIComponent(image.file.name) },
          });
          setEditorAttachments((current) => [...current, attachment]);
          URL.revokeObjectURL(image.previewUrl);
        } catch {
          failed.push(image);
        }
      }
      pendingImagesRef.current = failed;
      setPendingImages(failed);
      setReload((value) => value + 1);
      if (failed.length) {
        setError(`メモは保存しました。画像のアップロードに失敗: ${failed.map((item) => item.file.name).join("、")}。保存を押すと再試行できます。`);
      } else {
        closeEditor();
      }
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
      closeEditor();
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

  function queueImages(files: File[]) {
    if (working || !files.length) return;
    const valid: PendingImage[] = [];
    const invalid: string[] = [];
    for (const original of files) {
      if (!IMAGE_TYPES.includes(original.type)) {
        invalid.push(`${original.name || "画像"}: JPEG・PNG・WebP・GIF・AVIF のみ対応しています。`);
      } else if (!original.size || original.size > MAX_IMAGE_BYTES) {
        invalid.push(`${original.name || "画像"}: 1枚20MB以下にしてください。`);
      } else {
        const file = original.name ? original : new File([original], `貼り付け画像-${Date.now()}.${IMAGE_EXTENSIONS[original.type]}`, { type: original.type });
        valid.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
      }
    }
    if (valid.length) {
      pendingImagesRef.current = [...pendingImagesRef.current, ...valid];
      setPendingImages(pendingImagesRef.current);
    }
    setError(invalid.join(" "));
  }

  function addImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    queueImages(files);
  }

  function pasteImages(event: ClipboardEvent<HTMLFormElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    queueImages(files);
  }

  function dropImages(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingImage(false);
    queueImages(Array.from(event.dataTransfer.files));
  }

  function removePendingImage(id: string) {
    const removed = pendingImagesRef.current.find((item) => item.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    pendingImagesRef.current = pendingImagesRef.current.filter((item) => item.id !== id);
    setPendingImages(pendingImagesRef.current);
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
    if (!file || importing || exporting) return;
    setImporting(true);
    setImportMessage("ZIPを解析中…");
    setImportProgress(null);
    let extracted: KeepZipResult | null = null;
    try {
      extracted = await readKeepZip(file);
      const progress: ImportProgress = {
        notes: { done: extracted.failed + extracted.skipped, total: extracted.total,
          success: 0, trashed: 0, failed: extracted.failed, skipped: extracted.skipped },
        attachments: { done: 0, total: extracted.attachmentTotal, success: 0, failed: 0, skipped: 0 },
      };
      setImportProgress({ notes: { ...progress.notes }, attachments: { ...progress.attachments } });
      setImportMessage("インポート中…");
      for (const record of extracted.notes) {
        let noteId: string | null = null;
        try {
          const { note } = await api<{ note: Note }>("/api/import/keep", {
            method: "POST", body: JSON.stringify({ ...record.note, isTrashed: record.trashed }),
          });
          noteId = note.id;
          progress.notes.success += 1;
          if (record.trashed) progress.notes.trashed += 1;
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

  async function exportAll() {
    if (exporting || importing) return;
    setExporting(true);
    setExportProgress(null);
    setExportResult(null);
    setExportMessage("");
    const filename = backupFileName();
    let fileStream: WritableStream<Uint8Array> | null = null;
    try {
      type SaveHandle = { createWritable: () => Promise<WritableStream<Uint8Array>> };
      const picker = (window as Window & { showSaveFilePicker?: (options: {
        suggestedName: string; types: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<SaveHandle> }).showSaveFilePicker;
      if (picker) {
        const handle = await picker.call(window, { suggestedName: filename,
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }] });
        fileStream = await handle.createWritable();
      }
      const result = await createBackup(fileStream ?? new BlobWriter("application/zip"), setExportProgress);
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setExportResult(result);
      setExportMessage("エクスポート完了");
    } catch (cause) {
      if (fileStream) {
        try { await fileStream.abort(cause); } catch { /* ファイルが既に閉じている場合は何もしない。 */ }
      }
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        setExportMessage(cause instanceof Error ? cause.message : "エクスポートに失敗しました。");
      }
    } finally {
      setExporting(false);
    }
  }

  const labelOptions = [...availableLabels, ...selectedLabels].filter((name, index, all) =>
    all.findIndex((candidate) => labelKey(candidate) === labelKey(name)) === index);
  const deleteLabelNames = availableLabels.filter((name) => labelsToDelete.includes(labelKey(name)));
  const pinnedNotes = notes.filter((note) => note.pinned);
  const otherNotes = notes.filter((note) => !note.pinned);

  function renderNoteCard(note: Note) {
    const preview = richLinkPreview ? previews[note.url] : null;
    return (
      <article className="card" data-color={note.color} key={note.id}>
        {view === "trash"
          ? <div className="card-content">{notePreview(note)}</div>
          : <button className="card-content" onClick={() => openEditor(note)} aria-label={`${note.title || "無題のメモ"}を編集`}>{notePreview(note)}</button>}
        {note.url && (preview
          ? <a className="link-preview" href={note.url} target="_blank" rel="noopener noreferrer">
              {preview.image && !note.attachments.some((attachment) => IMAGE_TYPES.includes(attachment.mime_type))
                && <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              <span className="link-preview-details">
                <strong>{preview.title}</strong>
                <small>{preview.hostname}</small>
                {preview.description && <span>{preview.description}</span>}
              </span>
            </a>
          : <a className="note-link" href={note.url} target="_blank" rel="noopener noreferrer">{note.url}</a>)}
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
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <button type="button" className="menu-toggle" aria-label="メニューを開く" aria-controls="sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button>
          <h1><button type="button" className="home-button" onClick={goHome} title="メモへ戻る">MyKeep</button></h1>
        </div>
        <label className="search-field">検索
          <input type="search" value={search} maxLength={200} placeholder="タイトル・本文・URL" onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="header-actions">
          <button type="button" className="icon-button" aria-label="更新" title="更新" onClick={refreshCurrent}>↻</button>
          <div className="settings-menu-wrap" ref={settingsMenuRef}>
            <button type="button" className="icon-button" aria-label="設定メニュー" title="設定" aria-expanded={settingsMenuOpen} aria-haspopup="menu" onClick={() => setSettingsMenuOpen((open) => !open)}>⚙</button>
            {settingsMenuOpen && <div className="settings-dropdown" role="menu">
              <button type="button" role="menuitem" onClick={() => { setSettingsMenuOpen(false); setSettingsOpen(true); }}>設定</button>
              <button type="button" role="menuitem" onClick={() => { setSettingsMenuOpen(false); setImportOpen(true); }}>Keep Import</button>
              <button type="button" role="menuitem" onClick={() => { setSettingsMenuOpen(false); setExportOpen(true); void exportAll(); }} disabled={exporting || importing}>Export</button>
            </div>}
          </div>
          {view !== "trash" && <button type="button" className="primary new-note" aria-label="新規メモ" onClick={() => openEditor()}><span className="new-note-icon">＋</span><span className="new-note-text"> 新規メモ</span></button>}
        </div>
      </header>

      {menuOpen && <button type="button" className="sidebar-scrim" aria-label="メニューを閉じる" onClick={() => setMenuOpen(false)} />}
      <div className="app-layout">
        <aside id="sidebar" className={`sidebar${menuOpen ? " open" : ""}`} aria-label="サイドバー">
          <div className="sidebar-title">MyKeep</div>
          <nav className="sidebar-nav" aria-label="メモの表示">
            <button type="button" className={view === "active" && !labelFilter ? "selected" : ""} aria-current={view === "active" && !labelFilter ? "page" : undefined} onClick={() => selectView("active")}><span aria-hidden="true">💡</span>メモ</button>
            <button type="button" className={view === "archived" ? "selected" : ""} aria-current={view === "archived" ? "page" : undefined} onClick={() => selectView("archived")}><span aria-hidden="true">📦</span>アーカイブ</button>
            <button type="button" className={view === "trash" ? "selected" : ""} aria-current={view === "trash" ? "page" : undefined} onClick={() => selectView("trash")}><span aria-hidden="true">🗑</span>ゴミ箱</button>
          </nav>
          <div className="sidebar-labels">
            <h2>ラベル</h2>
            <nav className="sidebar-nav" aria-label="ラベル">
              {availableLabels.map((name) => <button type="button" className={view === "active" && labelFilter === name ? "selected" : ""} aria-current={view === "active" && labelFilter === name ? "page" : undefined} onClick={() => selectLabel(name)} key={name}><span aria-hidden="true">🏷</span>{name}</button>)}
              <button type="button" onClick={openLabelManager}><span aria-hidden="true">⚙</span>ラベル整理</button>
            </nav>
          </div>
        </aside>
        <div className="main-content">
      {error && !draft && <p className="error" role="alert">{error}</p>}
      {!loading && notes.length === 0 && <p className="empty">{search.trim() || labelFilter ? "該当するメモはありません。" : view === "active" ? "メモはまだありません。" : view === "archived" ? "アーカイブはありません。" : "ゴミ箱は空です。"}</p>}

      {view === "trash" ? (
        <section className="grid" aria-label="ゴミ箱一覧">{notes.map(renderNoteCard)}</section>
      ) : <>
        {pinnedNotes.length > 0 && <section className="grid" aria-label="ピン留めメモ">{pinnedNotes.map(renderNoteCard)}</section>}
        {pinnedNotes.length > 0 && otherNotes.length > 0 && <div className="note-section-separator" aria-hidden="true" />}
        {otherNotes.length > 0 && <section className="grid" aria-label={view === "active" ? "メモ一覧" : "アーカイブ一覧"}>{otherNotes.map(renderNoteCard)}</section>}
      </>}

      {loading && <p className="status">読み込み中…</p>}
      {hasMore && !loading && <button className="more" onClick={loadMore}>続きを読み込む</button>}
        </div>
      </div>

      {settingsOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="設定">
          <div className="editor-heading"><h2>設定</h2><button type="button" className="close" aria-label="閉じる" onClick={() => setSettingsOpen(false)}>×</button></div>
          <label className="setting-row"><input type="checkbox" checked={richLinkPreview} onChange={(event) => setRichLinkPreview(event.target.checked)} />リッチリンクプレビュー</label>
          <label className="setting-row"><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} />ダークモード</label>
        </section>
      </div>}

      {labelManagerOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingLabels) closeLabelManager(); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="ラベル整理">
          <div className="editor-heading"><h2>ラベル整理</h2><button type="button" className="close" aria-label="閉じる" onClick={closeLabelManager} disabled={deletingLabels}>×</button></div>
          {labelDeleteConfirm ? <>
            <p>{deleteLabelNames.length <= 3
              ? `「${deleteLabelNames.join("」「")}」を削除しますか？`
              : `選択した${deleteLabelNames.length}件のラベルを削除しますか？`}</p>
            <p>これらのラベルはメモからも外れます。メモ本体は削除されません。</p>
          </> : <div className="label-manager-list">
            {availableLabels.map((name) => <label key={labelKey(name)}>
              <input type="checkbox" checked={labelsToDelete.includes(labelKey(name))}
                disabled={deletingLabels || (labelsToDelete.length >= 50 && !labelsToDelete.includes(labelKey(name)))}
                onChange={() => toggleLabelToDelete(name)} />{name}
            </label>)}
            {availableLabels.length === 0 && <p>ラベルはありません。</p>}
          </div>}
          {labelDeleteError && <p className="error" role="alert">{labelDeleteError}</p>}
          <div className="label-manager-actions">
            <button type="button" className="label-cancel-button" onClick={() => labelDeleteConfirm ? setLabelDeleteConfirm(false) : closeLabelManager()} disabled={deletingLabels}>キャンセル</button>
            {labelDeleteConfirm
              ? <button type="button" className="label-delete-button" onClick={() => { void deleteSelectedLabels(); }} disabled={deletingLabels || deleteLabelNames.length === 0}>削除</button>
              : <button type="button" className="label-delete-button" onClick={() => { setLabelDeleteError(""); setLabelDeleteConfirm(true); }} disabled={deleteLabelNames.length === 0}>選択したラベルを削除</button>}
          </div>
        </section>
      </div>}

      {importOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) setImportOpen(false); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="Google Keep Import">
          <div className="editor-heading"><h2>Google Keep Import</h2><button type="button" className="close" aria-label="閉じる" onClick={() => setImportOpen(false)} disabled={importing}>×</button></div>
          <div className="import-content">
            <label>Takeout ZIPを選択
              <input type="file" accept=".zip,application/zip" onChange={importZip} disabled={importing || exporting} />
            </label>
            {importMessage && <p role="status">{importMessage}</p>}
            {importProgress && <p>メモ: {importProgress.notes.done} / {importProgress.notes.total}<br />
              成功 {importProgress.notes.success}　ゴミ箱として取込 {importProgress.notes.trashed}　失敗 {importProgress.notes.failed}　スキップ {importProgress.notes.skipped}<br />
              画像・添付: {importProgress.attachments.done} / {importProgress.attachments.total}<br />
              成功 {importProgress.attachments.success}　失敗 {importProgress.attachments.failed}　スキップ {importProgress.attachments.skipped}</p>}
          </div>
        </section>
      </div>}

      {exportOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) setExportOpen(false); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="Export">
          <div className="editor-heading"><h2>Export</h2><button type="button" className="close" aria-label="閉じる" onClick={() => setExportOpen(false)} disabled={exporting}>×</button></div>
          {exportProgress && exportProgress.stage !== "done" && <p role="status">
            メモ取得: {exportProgress.notesDone} / {exportProgress.notesTotal}<br />
            添付取得: {exportProgress.attachmentsDone} / {exportProgress.attachmentsTotal}<br />
            {exportProgress.stage === "zip" ? "ZIP作成中..." : exportProgress.stage === "notes" ? "メモ取得中..." : "添付取得中..."}
          </p>}
          {exportMessage && <p role="status">{exportMessage}</p>}
          {exportResult && <p>メモ {exportResult.notes}件　添付成功 {exportResult.attachmentsSucceeded}件　添付失敗 {exportResult.attachmentsFailed}件</p>}
        </section>
      </div>}

      {draft && (
        <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) closeEditor(); }}>
          <form className="editor" data-color={draft.color} onSubmit={save} onPaste={pasteImages} aria-label={editingId ? "メモを編集" : "新規メモ"}>
            <div className="editor-heading">
              <h2>{editingId ? "メモを編集" : "新規メモ"}</h2>
              <button type="button" className="close" onClick={closeEditor} disabled={working} aria-label="閉じる">×</button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <label>タイトル<input value={draft.title} maxLength={300} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>本文<textarea value={draft.body} maxLength={100000} rows={4} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
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
            <section className="editor-labels" aria-label="ラベル">
              <strong>ラベル</strong>
              <div className="label-picker" ref={labelMenuRef}>
                <button type="button" className="label-picker-toggle" aria-expanded={labelMenuOpen} aria-controls="editor-label-options"
                  onClick={() => setLabelMenuOpen((open) => !open)}>ラベルを選択 <span aria-hidden="true">▾</span></button>
                {labelMenuOpen && <div className="label-picker-menu" id="editor-label-options">
                  <button type="button" className="create-label-button" onClick={() => setCreatingLabel((current) => !current)}>＋ 新規ラベルを作成</button>
                  {creatingLabel && <div className="new-label-row">
                    <input aria-label="新しいラベル" placeholder="新しいラベル" value={newLabelName} maxLength={100}
                      onChange={(event) => setNewLabelName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addNewLabel(); } }} />
                    <button type="button" onClick={addNewLabel}>追加</button>
                  </div>}
                  <div className="label-options">
                    {labelOptions.map((name) => <label key={labelKey(name)}>
                      <input type="checkbox" checked={selectedLabels.some((label) => labelKey(label) === labelKey(name))}
                        onChange={() => toggleLabel(name)} />{name}
                    </label>)}
                  </div>
                </div>}
              </div>
              {selectedLabels.length > 0 && <div className="selected-labels">
                {selectedLabels.map((name) => <span className="selected-label" key={labelKey(name)}>{name}
                  <button type="button" aria-label={`${name}を解除`} onClick={() => toggleLabel(name)}>×</button>
                </span>)}
              </div>}
            </section>
            <label>URL<input type="url" value={draft.url} maxLength={2000} placeholder="https://" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
            <label>色<select value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value as NoteColor })}>
              {NOTE_COLORS.map((color) => <option value={color} key={color}>{COLOR_LABELS[color]}</option>)}
            </select></label>
            <div className="editor-options">
              <label><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} /> ピン留め</label>
              <label><input type="checkbox" checked={draft.archived} onChange={(event) => setDraft({ ...draft, archived: event.target.checked })} /> アーカイブ</label>
            </div>
            <section className="image-section" aria-label="添付ファイル">
              <strong>画像を追加</strong>
              <div className={`image-dropzone${draggingImage ? " dragging" : ""}`}
                onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDraggingImage(true); } }}
                onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDraggingImage(true); } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingImage(false); }}
                onDrop={dropImages}>
                <label className="upload-label">ファイルを選択
                  <input type="file" accept={IMAGE_TYPES.join(",")} multiple onChange={addImages} disabled={working} />
                </label>
                <span className="image-hint">Ctrl+Vで貼り付け / ここへドラッグ＆ドロップ</span>
              </div>
              {editorAttachments.length > 0 && <>
                <small className="image-group-label">保存済み</small>
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
              </>}
              {pendingImages.length > 0 && <>
                <small className="image-group-label">追加予定</small>
                <div className="editor-images">
                  {pendingImages.map((image) => <div className="editor-image" key={image.id}>
                    <img src={image.previewUrl} alt={image.file.name} />
                    <span className="pending-image-name" title={image.file.name}>{image.file.name}</span>
                    <button type="button" onClick={() => removePendingImage(image.id)} disabled={working} aria-label={`${image.file.name}を取り消す`}>取り消す</button>
                  </div>)}
                </div>
              </>}
            </section>
            <div className="editor-actions">
              {editingId && <button type="button" className="danger" onClick={remove} disabled={working}>ゴミ箱へ</button>}
              <button type="submit" className="primary" disabled={working || !(editingId || draft.title.trim() || draft.body.trim() || draft.url.trim() || draft.checklist.length || pendingImages.length)}>{working ? "保存中…" : "保存"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
