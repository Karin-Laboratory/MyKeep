import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent } from "react";
import { BlobWriter } from "@zip.js/zip.js";
import { backupFileName, createBackup } from "./exportBackup";
import type { BackupProgress, BackupResult } from "./exportBackup";
import { readKeepZip } from "./keepImport";
import type { KeepZipResult } from "./keepImport";
import { displayLinkTitle, getLinkPreview, mergeLinkPreview } from "./linkPreview";
import type { LinkPreview } from "./linkPreview";
import { NOTE_COLORS } from "./types";
import type { Attachment, ChecklistInput, Note, NoteColor, NoteInput } from "./types";

type View = "active" | "unpinned" | "imageless" | "archived" | "trash";
type NoteList = { notes: Note[]; hasMore: boolean };
type NoteCheck = { notes: Pick<Note, "id" | "updated_at">[] };
type SidebarCounts = { views: Record<View, number>; labels: Record<string, number> };
type ImportCounts = { done: number; total: number; success: number; failed: number; skipped: number };
type ImportProgress = { notes: ImportCounts & { trashed: number }; attachments: ImportCounts };
type NoteDraft = NoteInput & { checklist: ChecklistInput[] };
type PendingImage = { id: string; file: File; previewUrl: string };
type UndoAction = { message: string; undo?: () => Promise<void> };
type BulkOperation = "archive" | "unarchive" | "trash" | "restore" | "permanent" | "addLabels" | "removeLabel";
type BulkResult = { message: string; failed: number };
type CreatedLabel = { label: string; created: boolean };
type ScrollAnchor = { id: string | null; top: number; scrollY: number };
type ViewerImage = Pick<Attachment, "id" | "url" | "filename"> & { kind: "attachment" | "preview" };

const emptyNote: NoteDraft = { title: "", body: "", url: "", pinned: false, pin_level: 0, archived: false, color: "default", card_image: "auto", checklist: [] };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const countFormat = new Intl.NumberFormat("ja-JP");
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
};
const COLOR_LABELS: Record<NoteColor, string> = {
  default: "⚪", red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣",
};
const PREVIEW_SETTING = "mykeep.richLinkPreview";
const DARK_SETTING = "mykeep.darkMode";
const CARD_TITLE_SETTING = "mykeep.cardShowTitle";
const CARD_BODY_SETTING = "mykeep.cardShowBody";
const REFRESH_SETTING = "mykeep.autoRefreshSeconds";
const REFRESH_SECONDS = [10, 30, 60] as const;
type RefreshSeconds = typeof REFRESH_SECONDS[number];

function layoutNoteGrids(root: HTMLElement) {
  for (const grid of root.querySelectorAll<HTMLElement>(".grid")) {
    const style = getComputedStyle(grid);
    const columns = Number.parseInt(style.getPropertyValue("--card-columns"), 10);
    const gap = Number.parseFloat(style.getPropertyValue("--card-gap"));
    const cards = [...grid.querySelectorAll<HTMLElement>(":scope > .card")];
    cards.forEach((card, index) => {
      const column = String(index % columns + 1);
      if (card.style.gridColumn !== column) card.style.gridColumn = column;
    });
    const heights = cards.map((card) => Math.ceil(card.getBoundingClientRect().height));
    const bottoms = Array<number>(columns).fill(1);
    let previousStart = 1;
    const rows = heights.map((height, index) => {
      const column = index % columns;
      // Keep column order and never place a later card above an earlier card.
      const start = Math.max(bottoms[column], previousStart + (index > 0 && column === 0 ? 1 : 0));
      bottoms[column] = start + height + gap;
      previousStart = start;
      return `${start} / span ${height}`;
    });
    cards.forEach((card, index) => {
      if (card.style.gridRow !== rows[index]) card.style.gridRow = rows[index];
    });
  }
}

function restoreListAnchor(anchor: ScrollAnchor) {
  const card = [...document.querySelectorAll<HTMLElement>(".card[data-note-id]")]
    .find((element) => element.dataset.noteId === anchor.id);
  window.scrollTo({ top: card ? window.scrollY + card.getBoundingClientRect().top - anchor.top : anchor.scrollY, behavior: "instant" });
}

function SettingsIcon() {
  return <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 3-.6 2.4-2 .9-2.2-.7-3 5.2 1.7 1.6v2.3l-1.7 1.6 3 5.2 2.2-.7 2 .9L9 24h6l.6-2.4 2-.9 2.2.7 3-5.2-1.7-1.6v-2.3l1.7-1.6-3-5.2-2.2.7-2-.9L15 3Z" transform="translate(2 0) scale(.83)" />
    <circle cx="12" cy="12" r="3" />
  </svg>;
}

function ImageViewer({ images, initialIndex, onClose }: { images: ViewerImage[]; initialIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const image = images[index];
  function move(direction: number) {
    setIndex((current) => (current + direction + images.length) % images.length);
  }
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((current) => (current + (event.key === "ArrowLeft" ? -1 : 1) + images.length) % images.length);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [images.length, onClose]);
  return <div className="image-viewer" role="dialog" aria-modal="true" aria-label="画像ビューア"
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-viewer-toolbar">
      <span aria-live="polite">{index + 1} / {images.length}</span>
      {image.kind === "preview" && <a href={image.url} target="_blank" rel="noopener noreferrer">元画像を開く</a>}
      <button type="button" ref={closeRef} aria-label="画像ビューアを閉じる" title="閉じる" onClick={onClose}>×</button>
    </div>
    <div className="image-viewer-stage"
      onTouchStart={(event) => { touchRef.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }}
      onTouchEnd={(event) => {
        const start = touchRef.current;
        touchRef.current = null;
        const end = event.changedTouches[0];
        if (!start || !end || event.touches.length) return;
        const dx = end.clientX - start.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(end.clientY - start.y)) move(dx < 0 ? 1 : -1);
      }} onTouchCancel={() => { touchRef.current = null; }}>
      <img src={image.url} alt={image.filename} draggable={false} referrerPolicy={image.kind === "preview" ? "no-referrer" : undefined} />
    </div>
    <div className="image-viewer-navigation">
      <button type="button" disabled={images.length < 2} onClick={() => move(-1)} aria-label="前の画像">← 前</button>
      <button type="button" disabled={images.length < 2} onClick={() => move(1)} aria-label="次の画像">次 →</button>
    </div>
  </div>;
}

function labelKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

function normalizedLabelName(value: string): string | null {
  const name = value.trim().normalize("NFC");
  return name && name.length <= 100 ? name : null;
}

function trashRemainingDays(deletedAt: string | null): number | null {
  const deleted = deletedAt ? Date.parse(deletedAt) : NaN;
  if (!Number.isFinite(deleted)) return null;
  const day = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((deleted + 7 * day - Date.now()) / day));
}

function savedSetting(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function savedRefreshSeconds(): RefreshSeconds {
  try {
    const value = window.localStorage.getItem(REFRESH_SETTING);
    return REFRESH_SECONDS.find((seconds) => String(seconds) === value) ?? 30;
  } catch {
    return 30;
  }
}

function firstPageChanged(current: Note[], next: NoteCheck): boolean {
  const first = current.slice(0, 50);
  return first.length !== next.notes.length
    || first.some((note, index) => note.id !== next.notes[index].id || note.updated_at !== next.notes[index].updated_at);
}

function listParams(view: View, search: string, label: string): URLSearchParams {
  const params = new URLSearchParams({ view });
  if (search.trim()) params.set("q", search.trim());
  if (label) params.set("label", label);
  return params;
}

function listPath(view: View, search: string, label: string, offset: number): string {
  const params = listParams(view, search, label);
  params.set("offset", String(offset));
  return `/api/notes?${params}`;
}

type CardImage = { url: string; kind: "attachment" | "preview"; extra: number };

function resolveCardImage(note: Note, preview: LinkPreview | null): CardImage | null {
  const images = note.attachments.filter((item) => IMAGE_TYPES.includes(item.mime_type));
  const extra = Math.max(0, images.length + (note.preview_image ? 1 : 0) - 1);
  if (note.card_image === "preview" && note.preview_image) return { url: note.preview_image, kind: "preview", extra };
  if (note.card_image?.startsWith("attachment:")) {
    const selected = images.find((item) => item.id === note.card_image.slice(11));
    if (selected) return { url: selected.url, kind: "attachment", extra };
  }
  // 未指定・参照先消失は従来の自動表示へ戻す。
  if (images.length) return { url: images[0].url, kind: "attachment", extra: images.length - 1 };
  return preview?.image ? { url: preview.image, kind: "preview", extra: 0 } : null;
}

function notePreview(note: Note, showTitle: boolean, showBody: boolean, showArchive = false, cardImage: CardImage | null = null) {
  const imageAttachments = note.attachments.filter((item) => IMAGE_TYPES.includes(item.mime_type));
  return <>
    {note.pinned && <span className="pin-label">📌 {note.pin_level || 1}段目</span>}
    {showArchive && note.archived && <span className="pin-label">📦 アーカイブ</span>}
    {showTitle && note.title && <strong>{note.title}</strong>}
    {showBody && note.body && <span className="body-preview">{note.body}</span>}
    {note.checklist.length > 0 && <span className="checklist-preview">
      {note.checklist.map((item) => <span className={item.checked ? "checked" : ""} key={item.id}>
        {item.checked ? "☑" : "☐"} {item.text}
      </span>)}
    </span>}
    {note.labels.length > 0 && <span className="label-list">
      {note.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}
    </span>}
    {cardImage && (
      <span className="card-photo">
        <img src={cardImage.url} alt="" loading="lazy" referrerPolicy={cardImage.kind === "preview" ? "no-referrer" : undefined} />
        {cardImage.extra > 0 && <span className="photo-count">+{cardImage.extra}</span>}
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

function LabelCreator({ disabled, onCreate }: { disabled: boolean; onCreate: (name: string) => Promise<CreatedLabel> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pendingRef = useRef(false);
  async function add() {
    if (disabled || pendingRef.current) return;
    setMessage("");
    setError("");
    const normalized = normalizedLabelName(name);
    if (!normalized) { setError("ラベル名は1〜100文字で入力してください。"); return; }
    pendingRef.current = true;
    try {
      const result = await onCreate(normalized);
      setMessage(result.created ? `「${result.label}」を作成しました。` : `「${result.label}」は既に存在します。`);
      setName("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ラベルを作成できませんでした。");
    } finally { pendingRef.current = false; }
  }
  return <div className="standalone-label-creator">
    <button type="button" className="create-label-button" disabled={disabled} aria-expanded={open}
      onClick={() => { setOpen((current) => !current); setMessage(""); setError(""); }}>＋ 新規ラベルを作成</button>
    {open && <div className="new-label-row">
      <input aria-label="新しいラベル名" placeholder="新しいラベル名" maxLength={100} value={name} disabled={disabled}
        onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }} />
      <button type="button" disabled={disabled || !name.trim()} onClick={() => void add()}>追加</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}

export default function App() {
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [counts, setCounts] = useState<SidebarCounts | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [working, setWorking] = useState(false);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [undoing, setUndoing] = useState(false);
  const undoingRef = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [bulkLabelsOpen, setBulkLabelsOpen] = useState(false);
  const [bulkLabels, setBulkLabels] = useState<string[]>([]);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const labelRenameAliasesRef = useRef(new Map<string, string>());
  const bulkWorkingRef = useRef(false);
  const preservedLabelFilterRef = useRef("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [editorAttachments, setEditorAttachments] = useState<Attachment[]>([]);
  const [editorPreviewImage, setEditorPreviewImage] = useState("");
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
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
  const [creatingStandaloneLabel, setCreatingStandaloneLabel] = useState(false);
  const [labelDeleteError, setLabelDeleteError] = useState("");
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renamingLabel, setRenamingLabel] = useState(false);
  const [renameError, setRenameError] = useState("");
  const renamingLabelRef = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [richLinkPreview, setRichLinkPreview] = useState(() => savedSetting(PREVIEW_SETTING, true));
  const [cardShowTitle, setCardShowTitle] = useState(() => savedSetting(CARD_TITLE_SETTING, true));
  const [cardShowBody, setCardShowBody] = useState(() => savedSetting(CARD_BODY_SETTING, true));
  const [darkMode, setDarkMode] = useState(() => savedSetting(DARK_SETTING, false));
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(savedRefreshSeconds);
  const [previews, setPreviews] = useState<Record<string, LinkPreview | null>>({});
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const notesRef = useRef(notes);
  const lastListPathRef = useRef("");
  const refreshingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const moreControllerRef = useRef<AbortController | null>(null);
  const checkControllerRef = useRef<AbortController | null>(null);
  const listGenerationRef = useRef(0);
  const pagesLoadedRef = useRef(1);
  const pageLoadFailedRef = useRef(false);
  const hasMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const swipeClickUntilRef = useRef(0);
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  const deepLinkNoteRef = useRef(new URL(window.location.href).searchParams.get("note"));

  useEffect(() => {
    if (!undoAction || undoing) return;
    const timer = window.setTimeout(() => setUndoAction(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undoAction, undoing]);

  useEffect(() => {
    if (!bulkResult) return;
    const timer = window.setTimeout(() => setBulkResult(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [bulkResult]);

  useEffect(() => {
    const id = deepLinkNoteRef.current;
    if (!id) return;
    const controller = new AbortController();
    const clearLink = () => {
      deepLinkNoteRef.current = null;
      const url = new URL(window.location.href);
      url.searchParams.delete("note");
      window.history.replaceState(window.history.state, "", url);
    };
    api<{ note: Note }>(`/api/notes/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(({ note }) => {
        if (controller.signal.aborted) return;
        if (note.deleted_at) {
          setView("trash");
        } else {
          openEditor(note);
        }
        clearLink();
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "メモが見つかりません。");
        clearLink();
      });
    return () => controller.abort();
  }, []);

  useEffect(() => { notesRef.current = notes; }, [notes]);
  useLayoutEffect(() => {
    const root = mainContentRef.current;
    if (!root) return;
    let frame = 0;
    let width = root.getBoundingClientRect().width;
    const scheduleLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutNoteGrids(root));
    };
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (anchor) {
      layoutNoteGrids(root);
      restoreListAnchor(anchor);
    } else {
      scheduleLayout();
    }
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries.find((entry) => entry.target === root)?.contentRect.width ?? width;
      // Grid height changes after layout; only root width or card sizes need another pass.
      if (nextWidth !== width || entries.some((entry) => entry.target !== root)) scheduleLayout();
      width = nextWidth;
    });
    observer.observe(root);
    root.querySelectorAll<HTMLElement>(".card").forEach((card) => observer.observe(card));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [notes, view, selecting, cardShowTitle, cardShowBody]);
  useEffect(() => {
    setSelectedNoteIds(new Set());
    setSelecting(false);
    setBulkLabelsOpen(false);
    preservedLabelFilterRef.current = "";
  }, [view, search, labelFilter]);
  useEffect(() => {
    const loaded = new Set(notes.map((note) => note.id));
    setSelectedNoteIds((current) => {
      const remaining = new Set([...current].filter((id) => loaded.has(id)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [notes]);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);
  useEffect(() => () => { pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    try {
      window.localStorage.setItem(DARK_SETTING, String(darkMode));
      window.localStorage.setItem(PREVIEW_SETTING, String(richLinkPreview));
      window.localStorage.setItem(CARD_TITLE_SETTING, String(cardShowTitle));
      window.localStorage.setItem(CARD_BODY_SETTING, String(cardShowBody));
      window.localStorage.setItem(REFRESH_SETTING, String(autoRefreshSeconds));
    } catch { /* 保存できない環境でも画面内の設定は使える。 */ }
  }, [darkMode, richLinkPreview, cardShowTitle, cardShowBody, autoRefreshSeconds]);

  useEffect(() => {
    const controller = new AbortController();
    const path = listPath(view, search, labelFilter, 0);
    const changedFilter = path !== lastListPathRef.current;
    lastListPathRef.current = path;
    const generation = ++listGenerationRef.current;
    checkControllerRef.current?.abort();
    moreControllerRef.current?.abort();
    moreControllerRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    pageLoadFailedRef.current = false;
    const pages = changedFilter ? 1 : pagesLoadedRef.current;
    refreshingRef.current = true;
    if (changedFilter) {
      window.scrollTo({ top: 0, behavior: "instant" });
      scrollAnchorRef.current = null;
      pagesLoadedRef.current = 1;
      notesRef.current = [];
      hasMoreRef.current = false;
      setLoading(true);
      setNotes([]);
      setHasMore(false);
    }
    setError("");
    async function refresh() {
      try {
        const collected: Note[] = [];
        let more = false;
        let fetchedPages = 0;
        for (let page = 0; page < pages; page++) {
          const data = await api<NoteList>(listPath(view, search, labelFilter, page * 50), { signal: controller.signal });
          collected.push(...data.notes);
          fetchedPages++;
          more = data.hasMore && data.notes.length > 0;
          if (!more) break;
        }
        if (!controller.signal.aborted) {
          const orderChanged = notesRef.current.some((note, index) =>
            note.id !== collected[index]?.id || note.pinned !== collected[index]?.pinned || note.pin_level !== collected[index]?.pin_level);
          if (!changedFilter && orderChanged) {
            if (!scrollAnchorRef.current) scrollAnchorRef.current = captureListAnchor();
          } else {
            scrollAnchorRef.current = null;
          }
          notesRef.current = collected;
          pagesLoadedRef.current = fetchedPages;
          hasMoreRef.current = more;
          setNotes(collected);
          setHasMore(more);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          scrollAnchorRef.current = null;
          setError(cause instanceof Error ? cause.message : "読み込みに失敗しました。");
        }
      } finally {
        if (!controller.signal.aborted && generation === listGenerationRef.current) {
          refreshingRef.current = false;
          setLoading(false);
          setPullRefreshing(false);
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
        setLabelFilter((current) => current && !data.labels.includes(current)
          && current !== preservedLabelFilterRef.current ? "" : current);
      })
      .catch(() => setAvailableLabels([]));
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    api<SidebarCounts>("/api/counts", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setCounts(data); })
      .catch(() => { /* 件数取得の失敗では表示中の一覧を変えない。 */ });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    let active = true;
    let checking = false;
    async function checkForNewNotes() {
      if (document.visibilityState !== "visible" || refreshingRef.current || loadingMoreRef.current || bulkWorkingRef.current || checking) return;
      checking = true;
      const controller = new AbortController();
      checkControllerRef.current = controller;
      try {
        const data = await api<NoteCheck>(`/api/notes/check?${listParams(view, search, labelFilter)}`, { signal: controller.signal });
        if (active && !controller.signal.aborted && !refreshingRef.current && !loadingMoreRef.current
          && !bulkWorkingRef.current && firstPageChanged(notesRef.current, data)) reloadList();
      } catch { /* 自動確認の失敗は表示中の一覧に影響させない。 */ }
      finally {
        checking = false;
        if (checkControllerRef.current === controller) checkControllerRef.current = null;
      }
    }
    const interval = window.setInterval(() => { void checkForNewNotes(); }, autoRefreshSeconds * 1000);
    const onFocus = () => { void checkForNewNotes(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void checkForNewNotes(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      checkControllerRef.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [view, search, labelFilter, autoRefreshSeconds]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "0px 0px 240px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [notes, hasMore, loading, loadingMore, reload, view, search, labelFilter]);

  useEffect(() => () => { moreControllerRef.current?.abort(); }, []);

  useEffect(() => {
    const clearSwipeClick = () => { swipeClickUntilRef.current = 0; };
    const onClick = (event: MouseEvent) => {
      if (Date.now() >= swipeClickUntilRef.current) return;
      clearSwipeClick();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // A new touch is a separate tap; suppress only the click following a completed swipe.
    document.addEventListener("touchstart", clearSwipeClick, { capture: true, passive: true });
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("touchstart", clearSwipeClick, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useEffect(() => {
    const content = menuOpen ? sidebarRef.current : mainContentRef.current;
    if (!content || draft || viewerImageId || settingsOpen || labelManagerOpen || importOpen || exportOpen
      || importing || exporting || bulkLabelsOpen || settingsMenuOpen || selecting || working || undoing) return;
    let start: { x: number; y: number } | null = null;
    let direction: "horizontal" | "vertical" | null = null;
    let canPull = false;
    let distance = 0;
    const reset = () => { start = null; direction = null; distance = 0; setPullDistance(0); };
    const chooseDirection = (dx: number, dy: number) => {
      if (direction || Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.3) direction = "horizontal";
      else if (Math.abs(dy) >= Math.abs(dx)) direction = "vertical";
    };
    const onStart = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1 || refreshingRef.current
        || !window.matchMedia("(pointer: coarse), (max-width: 760px)").matches) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      canPull = !menuOpen && window.scrollY <= 3;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || refreshingRef.current) { reset(); return; }
      const dy = event.touches[0].clientY - start.y;
      const dx = event.touches[0].clientX - start.x;
      chooseDirection(dx, dy);
      if (direction === "horizontal") {
        if (window.matchMedia("(max-width: 760px)").matches && (menuOpen ? dx < 0 : dx > 0)
          && event.cancelable) event.preventDefault();
        return;
      }
      if (direction !== "vertical" || !canPull) return;
      if (window.scrollY > 3 || dy <= 0) { reset(); return; }
      if (event.cancelable) event.preventDefault();
      distance = Math.min(100, dy * .6);
      setPullDistance(distance);
    };
    const onEnd = (event: TouchEvent) => {
      const end = event.changedTouches[0];
      if (start && end && !event.touches.length) {
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        chooseDirection(dx, dy);
        if (window.matchMedia("(max-width: 760px)").matches && direction === "horizontal"
          && (menuOpen ? dx < -60 : dx > 60) && Math.abs(dx) > Math.abs(dy) * 1.3) {
          if (event.cancelable) event.preventDefault();
          swipeClickUntilRef.current = Date.now() + 700;
          reset();
          setMenuOpen(!menuOpen);
          return;
        }
      }
      const shouldRefresh = start && !event.touches.length && direction === "vertical" && canPull
        && distance >= 70 && window.scrollY <= 3 && !refreshingRef.current;
      reset();
      if (shouldRefresh) { setPullRefreshing(true); refreshCurrent(); }
    };
    content.addEventListener("touchstart", onStart, { passive: true });
    content.addEventListener("touchmove", onMove, { passive: false });
    content.addEventListener("touchend", onEnd, { passive: false });
    content.addEventListener("touchcancel", reset);
    return () => {
      content.removeEventListener("touchstart", onStart);
      content.removeEventListener("touchmove", onMove);
      content.removeEventListener("touchend", onEnd);
      content.removeEventListener("touchcancel", reset);
      reset();
    };
  }, [draft, viewerImageId, settingsOpen, labelManagerOpen, importOpen, exportOpen, importing, exporting, bulkLabelsOpen, menuOpen, settingsMenuOpen, selecting, working, undoing]);

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
    setViewerImageId(null);
    setEditorPreviewImage("");
    clearPendingImages();
    setDraft(null);
    setLabelMenuOpen(false);
    setCreatingLabel(false);
    setDraggingImage(false);
  }

  function openEditor(note?: Note) {
    setViewerImageId(null);
    setError("");
    clearPendingImages();
    setEditingId(note?.id ?? null);
    setEditorAttachments(note?.attachments ?? []);
    setEditorPreviewImage(note?.preview_image ?? "");
    setSelectedLabels(note?.labels ?? []);
    setLabelMenuOpen(false);
    setCreatingLabel(false);
    setNewLabelName("");
    setDraft(note
      ? { title: note.title, body: note.body, url: note.url, pinned: note.pinned, pin_level: note.pin_level ?? (note.pinned ? 1 : 0), archived: note.archived, color: note.color,
        card_image: note.card_image ?? "auto",
        checklist: note.checklist.map(({ text, checked }) => ({ text, checked })) }
      : { ...emptyNote, archived: view === "archived" });
  }

  function toggleLabel(name: string) {
    setSelectedLabels((current) => current.some((label) => labelKey(label) === labelKey(name))
      ? current.filter((label) => labelKey(label) !== labelKey(name))
      : current.length < 50 ? [...current, name] : current);
  }

  function addNewLabel() {
    const name = normalizedLabelName(newLabelName);
    if (!name) {
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

  async function createStandaloneLabel(name: string, selectForBulk = false): Promise<CreatedLabel> {
    setCreatingStandaloneLabel(true);
    try {
      const result = await api<CreatedLabel>("/api/labels", { method: "POST", body: JSON.stringify({ name }) });
      setAvailableLabels((current) => [...current.filter((label) => labelKey(label) !== labelKey(result.label)), result.label].sort());
      if (selectForBulk) setBulkLabels((current) => current.some((label) => labelKey(label) === labelKey(result.label)) ? current : [...current, result.label]);
      reloadList();
      return result;
    } finally { setCreatingStandaloneLabel(false); }
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
    cancelLabelRename();
  }

  function openLabelManager() {
    setLabelsToDelete([]);
    setLabelDeleteConfirm(false);
    setLabelDeleteError("");
    cancelLabelRename();
    setLabelManagerOpen(true);
    setMenuOpen(false);
  }

  function cancelLabelRename() {
    setEditingLabel(null);
    setRenameName("");
    setRenameError("");
  }

  async function renameLabel() {
    if (!editingLabel || renamingLabelRef.current || deletingLabels || creatingStandaloneLabel || working || undoing) return;
    const newName = normalizedLabelName(renameName);
    if (!newName) { setRenameError("ラベル名は1〜100文字で入力してください。"); return; }
    const oldKey = labelKey(editingLabel);
    renamingLabelRef.current = true;
    setRenamingLabel(true);
    setRenameError("");
    try {
      const { label } = await api<{ label: string }>("/api/labels", {
        method: "PATCH", body: JSON.stringify({ oldName: editingLabel, newName }),
      });
      const newKey = labelKey(label);
      const replaceLabels = (values: string[]) => [...new Map(values.map((name) => {
        const renamed = [oldKey, newKey].includes(labelKey(name)) ? label : name;
        return [labelKey(renamed), renamed] as const;
      })).values()];
      setAvailableLabels((current) => replaceLabels(current).sort());
      setSelectedLabels(replaceLabels);
      setBulkLabels(replaceLabels);
      setLabelsToDelete((current) => [...new Set(current.map((key) => key === oldKey ? newKey : key))]);
      setLabelFilter((current) => labelKey(current) === oldKey ? label : current);
      if (labelKey(preservedLabelFilterRef.current) === oldKey) preservedLabelFilterRef.current = label;
      setNotes((current) => current.map((note) => ({ ...note, labels: replaceLabels(note.labels) })));
      // A still-visible bulk Undo must restore the renamed label rather than recreate its old name.
      for (const [key, name] of labelRenameAliasesRef.current) {
        if (labelKey(name) === oldKey) labelRenameAliasesRef.current.set(key, label);
      }
      labelRenameAliasesRef.current.set(oldKey, label);
      cancelLabelRename();
      reloadList();
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "ラベル名を変更できませんでした。");
    } finally {
      renamingLabelRef.current = false;
      setRenamingLabel(false);
    }
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
      reloadList();
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

  function captureListAnchor(excludeId?: string | null): ScrollAnchor {
    const headerBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const candidates = [...document.querySelectorAll<HTMLElement>(".card[data-note-id]")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return element.dataset.noteId !== excludeId && rect.bottom > headerBottom && rect.top < window.innerHeight;
      });
    candidates.sort((a, b) => Math.abs(a.getBoundingClientRect().top - headerBottom) - Math.abs(b.getBoundingClientRect().top - headerBottom));
    const card = candidates[0];
    return { id: card?.dataset.noteId ?? null, top: card?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY };
  }

  function reloadList() {
    refreshingRef.current = true;
    checkControllerRef.current?.abort();
    moreControllerRef.current?.abort();
    setReload((value) => value + 1);
  }

  function refreshCurrent() {
    if (refreshingRef.current) return;
    reloadList();
  }

  async function loadMore() {
    if (refreshingRef.current || loadingMoreRef.current || !hasMoreRef.current || pageLoadFailedRef.current) return;
    const controller = new AbortController();
    const generation = listGenerationRef.current;
    const offset = pagesLoadedRef.current * 50;
    checkControllerRef.current?.abort();
    loadingMoreRef.current = true;
    moreControllerRef.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const data = await api<NoteList>(listPath(view, search, labelFilter, offset), { signal: controller.signal });
      if (controller.signal.aborted || generation !== listGenerationRef.current) return;
      const ids = new Set(notesRef.current.map((note) => note.id));
      const added = data.notes.filter((note) => !ids.has(note.id));
      notesRef.current = [...notesRef.current, ...added];
      pagesLoadedRef.current++;
      hasMoreRef.current = data.hasMore && added.length > 0;
      setNotes(notesRef.current);
      setHasMore(hasMoreRef.current);
    } catch (cause) {
      if (!controller.signal.aborted && generation === listGenerationRef.current) {
        pageLoadFailedRef.current = true;
        setError(`${cause instanceof Error ? cause.message : "読み込みに失敗しました。"} 更新ボタンで再試行してください。`);
      }
    } finally {
      if (moreControllerRef.current === controller) {
        moreControllerRef.current = null;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
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
      setDraft((current) => current ? { ...current, card_image: note.card_image } : current);
      setEditorPreviewImage(note.preview_image);
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
      scrollAnchorRef.current = captureListAnchor(editingId);
      reloadList();
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

  async function updatePinLevel(note: Note, level: number) {
    if (working) return;
    setWorking(true);
    setError("");
    setUndoAction(null);
    try {
      await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ pin_level: level }) });
      reloadList();
      setUndoAction({
        message: level ? `${level}段目にピン留めしました。` : "ピンを解除しました。",
        undo: async () => {
          await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ pin_level: note.pinned ? note.pin_level || 1 : 0 }) });
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新に失敗しました。");
    } finally { setWorking(false); }
  }

  async function updateFlag(note: Note, field: "pinned" | "archived") {
    if (working) return;
    const pinAnchor = field === "pinned" ? captureListAnchor(note.id) : null;
    const undoPin = field === "pinned" && note.pinned;
    setWorking(true);
    setError("");
    if (field === "archived" || undoPin) setUndoAction(null);
    try {
      await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !note[field] }) });
      if (pinAnchor) scrollAnchorRef.current = pinAnchor;
      reloadList();
      if (field === "archived") {
        setUndoAction({
          message: note.archived ? "アーカイブから戻しました。" : "アーカイブしました。",
          undo: async () => {
            await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ archived: note.archived }) });
          },
        });
      } else if (undoPin) {
        setUndoAction({
          message: "ピンを解除しました。",
          undo: async () => {
            const anchor = captureListAnchor(note.id);
            await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ pinned: true }) });
            scrollAnchorRef.current = anchor;
          },
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function moveCardToTrash(note: Note) {
    if (working) return;
    setWorking(true);
    setError("");
    setUndoAction(null);
    try {
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
      reloadList();
      setUndoAction({
        message: "ゴミ箱に移動しました。",
        undo: async () => { await api(`/api/notes/${note.id}/restore`, { method: "POST" }); },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "削除に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function undoLastAction() {
    if (!undoAction?.undo || working || undoingRef.current) return;
    undoingRef.current = true;
    setUndoing(true);
    setWorking(true);
    setError("");
    try {
      await undoAction.undo();
      reloadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取り消しに失敗しました。");
    } finally {
      setUndoAction(null);
      undoingRef.current = false;
      setUndoing(false);
      setWorking(false);
    }
  }

  function endSelection() {
    setSelecting(false);
    setSelectedNoteIds(new Set());
    setBulkLabelsOpen(false);
  }

  function toggleNoteSelection(id: string) {
    if (working) return;
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulk(operation: BulkOperation, labels: string[] = []) {
    const ids = notes.filter((note) => selectedNoteIds.has(note.id)
      && (operation !== "archive" || !note.archived)
      && (operation !== "unarchive" || note.archived)).map((note) => note.id);
    if (!ids.length || working || bulkWorkingRef.current) return;
    if (operation === "permanent" && !window.confirm(`選択した${ids.length}件を完全に削除しますか？\nこの操作は元に戻せません。`)) return;
    const removedLabel = labelFilter;
    const messages: Record<BulkOperation, string> = {
      archive: "アーカイブしました。", unarchive: "メモに戻しました。", trash: "ゴミ箱に移動しました。",
      restore: "復元しました。", permanent: "完全削除しました。", addLabels: "ラベルを追加しました。",
      removeLabel: `「${removedLabel}」を外しました。`,
    };
    bulkWorkingRef.current = true;
    setWorking(true);
    setError("");
    setBulkResult(null);
    setUndoAction(null);
    labelRenameAliasesRef.current.clear();
    const succeeded: Note[] = [];
    let failed = 0;
    const failures: string[] = [];
    try {
      if (operation === "addLabels") {
        const { labels: existing } = await api<{ labels: string[] }>("/api/labels");
        if (!labels.length || labels.some((label) => !existing.some((name) => labelKey(name) === labelKey(label)))) {
          throw new Error("追加する既存ラベルを選び直してください。");
        }
      }
      if (labelFilter) preservedLabelFilterRef.current = labelFilter;
      for (const id of ids) {
        try {
          const { note } = await api<{ note: Note }>(`/api/notes/${id}`);
          if ((operation === "archive" && note.archived) || (operation === "unarchive" && !note.archived)) continue;
          if (operation === "trash" || operation === "permanent") {
            await api(`/api/notes/${id}${operation === "permanent" ? "/permanent" : ""}`, { method: "DELETE" });
          } else if (operation === "restore") {
            await api(`/api/notes/${id}/restore`, { method: "POST" });
          } else {
            let changes: { archived: boolean } | { labels: string[] };
            if (operation === "archive" || operation === "unarchive") {
              changes = { archived: operation === "archive" };
            } else if (operation === "removeLabel") {
              changes = { labels: note.labels.filter((label) => labelKey(label) !== labelKey(removedLabel)) };
            } else {
              const merged = [...note.labels];
              for (const label of labels) {
                if (!merged.some((name) => labelKey(name) === labelKey(label))) merged.push(label);
              }
              if (merged.length > 50) throw new Error("1メモのラベルは50件までです。");
              changes = { labels: merged };
            }
            await api(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
          }
          succeeded.push(note);
        } catch (cause) {
          failed++;
          if (failures.length < 3) failures.push(cause instanceof Error ? cause.message : "処理に失敗しました。");
        }
      }
    } catch (cause) {
      failed = ids.length;
      failures.push(cause instanceof Error ? cause.message : "処理に失敗しました。");
    } finally {
      bulkWorkingRef.current = false;
      setWorking(false);
    }
    const particle = operation === "addLabels" ? "件に" : operation === "removeLabel" ? "件から" : "件を";
    const message = `${succeeded.length}${particle}${messages[operation]}`;
    setBulkResult({ message: `成功 ${succeeded.length}件 / 失敗 ${failed}件${failed ? `：${[...new Set(failures)].join("、")}` : ""}`, failed });
    endSelection();
    reloadList();
    if (!succeeded.length) return;
    setUndoAction(operation === "permanent" ? { message } : {
      message,
      undo: async () => {
        bulkWorkingRef.current = true;
        let undone = 0;
        let undoFailed = 0;
        try {
          for (const note of succeeded) {
            try {
              if (operation === "trash") {
                await api(`/api/notes/${note.id}/restore`, { method: "POST" });
                await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ archived: note.archived }) });
              } else if (operation === "restore") {
                await api(`/api/notes/${note.id}`, { method: "DELETE", body: JSON.stringify({ deleted_at: note.deleted_at }) });
              } else {
                await api(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify(
                  operation === "archive" || operation === "unarchive" ? { archived: note.archived }
                    : { labels: note.labels.map((name) => labelRenameAliasesRef.current.get(labelKey(name)) ?? name) },
                ) });
              }
              undone++;
            } catch { undoFailed++; }
          }
        } finally { bulkWorkingRef.current = false; }
        setBulkResult({ message: `取り消し成功 ${undone}件 / 失敗 ${undoFailed}件`, failed: undoFailed });
      },
    });
  }

  async function remove() {
    if (!editingId || working || !window.confirm("このメモをゴミ箱に移動しますか？")) return;
    setWorking(true);
    setError("");
    try {
      await api(`/api/notes/${editingId}`, { method: "DELETE" });
      closeEditor();
      reloadList();
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
      reloadList();
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
      reloadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "完全削除に失敗しました。");
    } finally {
      setWorking(false);
    }
  }

  async function clearTrash() {
    if (working || importing || exporting) return;
    setWorking(true);
    setError("");
    try {
      const current = await api<SidebarCounts>("/api/counts");
      setCounts(current);
      if (!current.views.trash || !window.confirm(`ゴミ箱内の${countFormat.format(current.views.trash)}件のメモを完全に削除しますか？\nこの操作は取り消せません。`)) return;
      setUndoAction(null);
      const result = await api<{ deleted: number; failed: number }>("/api/trash", { method: "DELETE" });
      endSelection();
      setBulkResult(null);
      reloadList();
      if (result.failed) setBulkResult({ message: `${result.deleted}件を完全削除しました。${result.failed}件の削除に失敗しました。残ったメモは再試行できます。`, failed: result.failed });
      else setUndoAction({ message: "ゴミ箱を空にしました。" });
    } catch (cause) {
      // 応答が途切れた場合も、削除できた分を再取得して反映する。
      reloadList();
      setBulkResult({ message: cause instanceof Error ? cause.message : "ゴミ箱を空にできませんでした。", failed: 1 });
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
      setDraft((current) => current?.card_image === `attachment:${attachment.id}` ? { ...current, card_image: "auto" } : current);
      setNotes((current) => current.map((note) => note.id === editingId
        ? { ...note, card_image: note.card_image === `attachment:${attachment.id}` ? "auto" : note.card_image,
          attachments: note.attachments.filter((item) => item.id !== attachment.id) }
        : note));
      reloadList();
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
      reloadList();
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
  const labelManagerBusy = deletingLabels || creatingStandaloneLabel || renamingLabel || working || undoing;
  const viewerImages: ViewerImage[] = editorAttachments.filter((attachment) => IMAGE_TYPES.includes(attachment.mime_type))
    .map(({ id, url, filename }) => ({ id, url, filename, kind: "attachment" }));
  if (editorPreviewImage) viewerImages.push({ id: "link-preview", url: editorPreviewImage, filename: "サムネイル", kind: "preview" });
  const pinRows = [1, 2, 3].map((level) => ({ level, notes: notes.filter((note) => note.pinned && (note.pin_level || 1) === level) }));
  const otherNotes = notes.filter((note) => !note.pinned);
  const selectedActiveCount = notes.filter((note) => selectedNoteIds.has(note.id) && !note.archived).length;
  const selectedArchivedCount = notes.filter((note) => selectedNoteIds.has(note.id) && note.archived).length;

  function renderNoteCard(note: Note) {
    const visiblePreview = richLinkPreview ? mergeLinkPreview(note, previews[note.url]) : null;
    const cardImage = resolveCardImage(note, visiblePreview);
    const contentImage = cardImage?.kind === "preview" && note.url && visiblePreview ? null : cardImage;
    const remainingDays = view === "trash" ? trashRemainingDays(note.deleted_at) : null;
    const selected = selectedNoteIds.has(note.id);
    return (
      <article className={`card${selected ? " selected-card" : ""}`} data-color={note.color} data-note-id={note.id} key={note.id}
        onClick={selecting ? () => toggleNoteSelection(note.id) : undefined}>
        {selecting && <button type="button" className="card-select" aria-label={`${note.title || "無題のメモ"}${selected ? "の選択を解除" : "を選択"}`}
          aria-pressed={selected} disabled={working} onClick={(event) => { event.stopPropagation(); toggleNoteSelection(note.id); }}>{selected ? "✓" : ""}</button>}
        {view === "trash" || selecting
          ? <div className="card-content">{notePreview(note, cardShowTitle, cardShowBody, Boolean(labelFilter), contentImage)}</div>
          : <button className="card-content" onClick={() => openEditor(note)} aria-label={`${note.title || "無題のメモ"}を編集`}>{notePreview(note, cardShowTitle, cardShowBody, Boolean(labelFilter), contentImage)}</button>}
        {note.url && (visiblePreview
          ? <a className="link-preview" href={note.url} target="_blank" rel="noopener noreferrer"
              tabIndex={selecting ? -1 : undefined} onClick={selecting ? (event) => event.preventDefault() : undefined}
              onAuxClick={selecting ? (event) => event.preventDefault() : undefined}>
              {cardImage?.kind === "preview" && <span className="link-preview-photo">
                <img src={cardImage.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                {cardImage.extra > 0 && <span className="photo-count">+{cardImage.extra}</span>}
              </span>}
              <span className="link-preview-details">
                <strong>{displayLinkTitle(visiblePreview, note.title)}</strong>
                <small>{visiblePreview.hostname}</small>
                {visiblePreview.description && <span>{visiblePreview.description}</span>}
              </span>
            </a>
          : <a className="note-link" href={note.url} target="_blank" rel="noopener noreferrer"
              tabIndex={selecting ? -1 : undefined} onClick={selecting ? (event) => event.preventDefault() : undefined}
              onAuxClick={selecting ? (event) => event.preventDefault() : undefined}>{note.url}</a>)}
        {remainingDays !== null && <p className="trash-countdown">
          {remainingDays > 0 ? `完全削除まで あと${remainingDays}日` : "まもなく完全削除"}
        </p>}
        {!selecting && <div className="card-actions">
          {view === "trash" ? <>
            <button disabled={working} onClick={() => restore(note)}>復元</button>
            <button className="danger" disabled={working} onClick={() => permanentlyRemove(note)}>完全削除</button>
          </> : <>
            <select className="pin-select" aria-label={`${note.title || "無題のメモ"}のピン留め先`} disabled={working}
              value={note.pinned ? note.pin_level || 1 : 0} onChange={(event) => updatePinLevel(note, Number(event.target.value))}>
              <option value={0}>ピンなし</option><option value={1}>1段目・ピンク</option>
              <option value={2}>2段目・イエロー</option><option value={3}>3段目・ブルー</option>
            </select>
            <button disabled={working} onClick={() => updateFlag(note, "archived")}>{note.archived ? "戻す" : "アーカイブ"}</button>
            {note.archived && <button className="trash-action" disabled={working} onClick={() => moveCardToTrash(note)}>ゴミ箱</button>}
          </>}
        </div>}
      </article>
    );
  }

  return (
    <main className={`app${selecting ? " selecting" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <button type="button" className="menu-toggle" aria-label="メニューを開く" aria-controls="sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button>
          <h1><button type="button" className="home-button" onClick={goHome} title="メモへ戻る">MyKeep</button></h1>
        </div>
        <label className="search-field">検索
          <input type="search" value={search} maxLength={200} placeholder="タイトル・本文・URL" onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="header-actions">
          <button type="button" className={`icon-button${selecting ? " active" : ""}`} aria-label={selecting ? "選択モードを終了" : "メモを選択"}
            title={selecting ? "選択を終了" : "選択"} aria-pressed={selecting} disabled={working || (!selecting && loading)}
            onClick={() => { if (selecting) endSelection(); else { setSelecting(true); setBulkResult(null); } }}>☑</button>
          <button type="button" className="icon-button" aria-label="更新" title="更新" onClick={refreshCurrent}>↻</button>
          <div className="settings-menu-wrap" ref={settingsMenuRef}>
            <button type="button" className="icon-button" aria-label="設定メニュー" title="設定" aria-expanded={settingsMenuOpen} aria-haspopup="menu" onClick={() => setSettingsMenuOpen((open) => !open)}><SettingsIcon /></button>
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
        <aside id="sidebar" ref={sidebarRef} className={`sidebar${menuOpen ? " open" : ""}`} aria-label="サイドバー">
          <div className="sidebar-title">MyKeep</div>
          <nav className="sidebar-nav" aria-label="メモの表示">
            {([
              ["active", "💡", "メモ"], ["unpinned", "○", "ピンなし"], ["imageless", "▧", "画像なし"],
              ["archived", "📦", "アーカイブ"], ["trash", "🗑", "ゴミ箱"],
            ] as const).map(([itemView, icon, name]) => <button type="button" key={itemView}
              className={view === itemView && !labelFilter ? "selected" : ""}
              aria-current={view === itemView && !labelFilter ? "page" : undefined} onClick={() => selectView(itemView)}>
              <span aria-hidden="true">{icon}</span><span className="nav-name">{name}</span>
              <span className="nav-count">{counts ? countFormat.format(counts.views[itemView]) : "—"}</span>
            </button>)}
          </nav>
          <div className="sidebar-labels">
            <h2>ラベル</h2>
            <nav className="sidebar-nav" aria-label="ラベル">
              {availableLabels.map((name) => <button type="button" className={view === "active" && labelFilter === name ? "selected" : ""} aria-current={view === "active" && labelFilter === name ? "page" : undefined} onClick={() => selectLabel(name)} key={name} title={name}>
                <span aria-hidden="true">🏷</span><span className="nav-name">{name}</span>
                <span className="nav-count">{counts ? countFormat.format(Object.hasOwn(counts.labels, name) ? counts.labels[name] : 0) : "—"}</span>
              </button>)}
              <button type="button" onClick={openLabelManager}><SettingsIcon />ラベル整理</button>
            </nav>
          </div>
        </aside>
        <div className="main-content" ref={mainContentRef}>
      {(pullDistance > 0 || pullRefreshing) && <div className="pull-indicator" role="status" style={{ height: pullRefreshing ? 38 : Math.min(pullDistance, 80) }}>↻ {pullRefreshing ? "更新中…" : pullDistance >= 70 ? "離して更新" : "引っ張って更新"}</div>}
      {view === "trash" && <div className="trash-header">
        <p>ゴミ箱内のメモは7日後に削除されます。</p>
        <button type="button" className="danger" disabled={working || importing || exporting || !counts?.views.trash} onClick={() => void clearTrash()}>ゴミ箱を空にする</button>
      </div>}
      {bulkResult && <p className={bulkResult.failed ? "error" : "bulk-result"} role={bulkResult.failed ? "alert" : "status"}>{bulkResult.message}</p>}
      {error && !draft && <p className="error" role="alert">{error}</p>}
      {!loading && notes.length === 0 && <p className="empty">{search.trim() || labelFilter ? "該当するメモはありません。" : view === "active" ? "メモはまだありません。" : view === "unpinned" ? "ピンなしのメモはありません。" : view === "imageless" ? "画像なしのメモはありません。" : view === "archived" ? "アーカイブはありません。" : "ゴミ箱は空です。"}</p>}

      {view === "trash" ? (
        <section className="grid" aria-label="ゴミ箱一覧">{notes.map(renderNoteCard)}</section>
      ) : <>
        {view !== "unpinned" && pinRows.map(({ level, notes: rowNotes }) => (view === "active" || rowNotes.length > 0) &&
          <section className="pin-row" data-pin-level={level} key={level} aria-label={`${level}段目のピン留めメモ`}>
            <h2>📌 {level}段目</h2>
            {rowNotes.length > 0 ? <div className="grid">{rowNotes.map(renderNoteCard)}</div>
              : <p className="pin-row-empty">この段にピン留めしたメモはありません。</p>}
          </section>)}
        {otherNotes.length > 0 && <section className="grid" aria-label={view === "active" ? "メモ一覧" : view === "unpinned" ? "ピンなしメモ一覧" : view === "imageless" ? "画像なしメモ一覧" : "アーカイブ一覧"}>{otherNotes.map(renderNoteCard)}</section>}
      </>}

      {(loading || loadingMore) && <p className="status">読み込み中…</p>}
      <div className="list-sentinel" ref={sentinelRef} aria-hidden="true" />
        </div>
      </div>

      {selecting && <section className="bulk-toolbar" aria-label="一括操作">
        <div className="bulk-selection-controls">
          <strong aria-live="polite">{selectedNoteIds.size}件選択</strong>
          <button type="button" disabled={working || loading} onClick={() => setSelectedNoteIds(new Set(notes.map((note) => note.id)))}>全選択</button>
          <button type="button" disabled={working || !selectedNoteIds.size} onClick={() => setSelectedNoteIds(new Set())}>全解除</button>
          <button type="button" disabled={working} onClick={endSelection}>終了</button>
        </div>
        <div className="bulk-operation-controls">
          {view === "trash" ? <>
            <button type="button" disabled={working || !selectedNoteIds.size} onClick={() => void runBulk("restore")}>復元</button>
            <button type="button" className="bulk-danger" disabled={working || !selectedNoteIds.size} onClick={() => void runBulk("permanent")}>完全削除</button>
          </> : <>
            {view === "active" && labelFilter && <button type="button" disabled={working || !selectedNoteIds.size} onClick={() => void runBulk("removeLabel")}>このラベルを外す</button>}
            {labelFilter ? <>
              <button type="button" disabled={working || !selectedActiveCount} onClick={() => void runBulk("archive")}>アーカイブ</button>
              <button type="button" disabled={working || !selectedArchivedCount} onClick={() => void runBulk("unarchive")}>メモに戻す</button>
            </> : <button type="button" disabled={working || !selectedNoteIds.size} onClick={() => void runBulk(view === "archived" ? "unarchive" : "archive")}>{view === "archived" ? "メモに戻す" : "アーカイブ"}</button>}
            <button type="button" disabled={working || !selectedNoteIds.size} onClick={() => { setBulkLabels([]); setBulkLabelsOpen(true); }}>{labelFilter ? "他のラベルを付ける" : "ラベル"}</button>
            <button type="button" className="bulk-danger" disabled={working || !selectedNoteIds.size} onClick={() => void runBulk("trash")}>ゴミ箱</button>
          </>}
          {working && <span role="status">処理中…</span>}
        </div>
      </section>}

      {undoAction && <div className="snackbar" role="status" aria-atomic="true">
        <span>{undoAction.message}</span>
        {undoAction.undo && <button type="button" disabled={working || undoing} onClick={() => void undoLastAction()}>取り消す</button>}
      </div>}

      {bulkLabelsOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !working && !creatingStandaloneLabel) setBulkLabelsOpen(false); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="一括ラベル追加">
          <div className="editor-heading"><h2>ラベルを追加</h2><button type="button" className="close" aria-label="閉じる" disabled={working || creatingStandaloneLabel} onClick={() => setBulkLabelsOpen(false)}>×</button></div>
          <LabelCreator disabled={working || creatingStandaloneLabel || bulkLabels.length >= 50} onCreate={(name) => createStandaloneLabel(name, true)} />
          <div className="label-manager-list">
            {availableLabels.map((name) => <label key={name}><input type="checkbox" checked={bulkLabels.includes(name)} disabled={working || creatingStandaloneLabel || (!bulkLabels.includes(name) && bulkLabels.length >= 50)}
              onChange={() => setBulkLabels((current) => current.includes(name) ? current.filter((label) => label !== name) : [...current, name])} />{name}</label>)}
          </div>
          {!availableLabels.length && <p>登録済みラベルはありません。</p>}
          <div className="label-manager-actions">
            <button type="button" className="label-cancel-button" disabled={working || creatingStandaloneLabel} onClick={() => setBulkLabelsOpen(false)}>キャンセル</button>
            <button type="button" className="primary" disabled={working || creatingStandaloneLabel || !bulkLabels.length || !selectedNoteIds.size} onClick={() => void runBulk("addLabels", bulkLabels)}>適用</button>
          </div>
        </section>
      </div>}

      {settingsOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="設定">
          <div className="editor-heading"><h2>設定</h2><button type="button" className="close" aria-label="閉じる" onClick={() => setSettingsOpen(false)}>×</button></div>
          <label className="setting-row"><input type="checkbox" checked={richLinkPreview} onChange={(event) => setRichLinkPreview(event.target.checked)} />リッチリンクプレビュー</label>
          <label className="setting-row"><input type="checkbox" checked={cardShowTitle} onChange={(event) => setCardShowTitle(event.target.checked)} />タイトル表示</label>
          <label className="setting-row"><input type="checkbox" checked={cardShowBody} onChange={(event) => setCardShowBody(event.target.checked)} />本文表示</label>
          <label className="setting-row"><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} />ダークモード</label>
          <label className="setting-row">自動更新間隔
            <select value={autoRefreshSeconds} onChange={(event) => {
              setAutoRefreshSeconds(REFRESH_SECONDS.find((seconds) => String(seconds) === event.target.value) ?? 30);
            }}>
              {REFRESH_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{seconds}秒</option>)}
            </select>
          </label>
        </section>
      </div>}

      {labelManagerOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !labelManagerBusy) closeLabelManager(); }}>
        <section className="utility-modal" role="dialog" aria-modal="true" aria-label="ラベル整理">
          <div className="editor-heading"><h2>ラベル整理</h2><button type="button" className="close" aria-label="閉じる" onClick={closeLabelManager} disabled={labelManagerBusy}>×</button></div>
          {!labelDeleteConfirm && <LabelCreator disabled={labelManagerBusy || editingLabel !== null} onCreate={(name) => createStandaloneLabel(name)} />}
          {labelDeleteConfirm ? <>
            <p>{deleteLabelNames.length <= 3
              ? `「${deleteLabelNames.join("」「")}」を削除しますか？`
              : `選択した${deleteLabelNames.length}件のラベルを削除しますか？`}</p>
            <p>これらのラベルはメモからも外れます。メモ本体は削除されません。</p>
          </> : <div className="label-manager-list">
            {availableLabels.map((name) => <div className="label-manager-entry" key={labelKey(name)}>
              <div className="label-manager-row">
                <label><input type="checkbox" checked={labelsToDelete.includes(labelKey(name))}
                  disabled={labelManagerBusy || editingLabel !== null || (labelsToDelete.length >= 50 && !labelsToDelete.includes(labelKey(name)))}
                  onChange={() => toggleLabelToDelete(name)} />{name}</label>
                <button type="button" aria-label={`${name}のラベル名を変更`} title="ラベル名を変更"
                  disabled={labelManagerBusy || editingLabel !== null}
                  onClick={() => { setEditingLabel(name); setRenameName(name); setRenameError(""); setLabelDeleteError(""); }}>✎</button>
              </div>
              {editingLabel === name && <div className="label-rename-row">
                <input aria-label="変更後のラベル名" value={renameName} maxLength={100} disabled={labelManagerBusy}
                  onChange={(event) => setRenameName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void renameLabel(); } }} />
                <button type="button" className="primary" disabled={labelManagerBusy || !renameName.trim()} onClick={() => void renameLabel()}>保存</button>
                <button type="button" disabled={labelManagerBusy} onClick={cancelLabelRename}>キャンセル</button>
              </div>}
            </div>)}
            {availableLabels.length === 0 && <p>ラベルはありません。</p>}
          </div>}
          {labelDeleteError && <p className="error" role="alert">{labelDeleteError}</p>}
          {renameError && <p className="error" role="alert">{renameError}</p>}
          <div className="label-manager-actions">
            <button type="button" className="label-cancel-button" onClick={() => labelDeleteConfirm ? setLabelDeleteConfirm(false) : closeLabelManager()} disabled={labelManagerBusy}>キャンセル</button>
            {labelDeleteConfirm
              ? <button type="button" className="label-delete-button" onClick={() => { void deleteSelectedLabels(); }} disabled={labelManagerBusy || deleteLabelNames.length === 0}>削除</button>
              : <button type="button" className="label-delete-button" onClick={() => { setLabelDeleteError(""); setLabelDeleteConfirm(true); }} disabled={labelManagerBusy || editingLabel !== null || deleteLabelNames.length === 0}>選択したラベルを削除</button>}
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
            <label>本文<textarea value={draft.body} maxLength={100000} rows={3} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
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
            <div className="editor-options">
              <label className="editor-color">色<select aria-label="メモの色" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value as NoteColor })}>
              {NOTE_COLORS.map((color) => <option value={color} key={color}>{COLOR_LABELS[color]}</option>)}
            </select></label>
              <label>ピン留め先 <select value={draft.pinned ? draft.pin_level || 1 : 0}
                onChange={(event) => { const level = Number(event.target.value); setDraft({ ...draft, pinned: level > 0, pin_level: level }); }}>
                <option value={0}>ピンなし</option><option value={1}>1段目・ピンク</option>
                <option value={2}>2段目・イエロー</option><option value={3}>3段目・ブルー</option>
              </select></label>
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
              {(editorAttachments.length > 0 || editorPreviewImage) && <>
                <small className="image-group-label">保存済み</small>
                <div className="card-image-choice" role="group" aria-label="カードに表示する画像">
                  <span>カードに表示する画像</span>
                  <label><input type="radio" name="card-image" value="auto" checked={(draft.card_image ?? "auto") === "auto"} disabled={working}
                    onChange={() => setDraft({ ...draft, card_image: "auto" })} />自動</label>
                </div>
                <div className="editor-images">
                    {editorAttachments.map((attachment) => (
                      <div className="editor-image" key={attachment.id}>
                        {IMAGE_TYPES.includes(attachment.mime_type)
                          ? <button type="button" className="image-thumbnail" aria-label={`${attachment.filename}を拡大表示`} onClick={() => setViewerImageId(attachment.id)}><img src={attachment.url} alt={attachment.filename} loading="lazy" /></button>
                          : <a href={attachment.url} download={attachment.filename}>{attachment.filename}</a>}
                        <button type="button" onClick={() => removeImage(attachment)} disabled={working} aria-label={`${attachment.filename}を削除`}>削除</button>
                        {IMAGE_TYPES.includes(attachment.mime_type) && <label className="card-image-radio">
                          <input type="radio" name="card-image" value={`attachment:${attachment.id}`} checked={draft.card_image === `attachment:${attachment.id}`} disabled={working}
                            aria-label={`${attachment.filename}をカードに表示`} onChange={() => setDraft({ ...draft, card_image: `attachment:${attachment.id}` })} />カード表示
                        </label>}
                      </div>
                    ))}
                    {editorPreviewImage && <div className="editor-image">
                      <button type="button" className="image-thumbnail" aria-label="サムネイルを拡大表示" onClick={() => setViewerImageId("link-preview")}><img src={editorPreviewImage} alt="リンクサムネイル" loading="lazy" referrerPolicy="no-referrer" /></button>
                      <small className="image-group-label">サムネイル</small>
                      <label className="card-image-radio"><input type="radio" name="card-image" value="preview" checked={draft.card_image === "preview"} disabled={working}
                        aria-label="サムネイルをカードに表示" onChange={() => setDraft({ ...draft, card_image: "preview" })} />カード表示</label>
                    </div>}
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
      {viewerImageId && viewerImages.length > 0 && <ImageViewer images={viewerImages} initialIndex={Math.max(0, viewerImages.findIndex((image) => image.id === viewerImageId))} onClose={() => setViewerImageId(null)} />}
    </main>
  );
}
