import type { Note } from "./types";

export interface LinkPreview {
  title: string;
  description: string;
  image: string;
  hostname: string;
}

function meaningfulTitle(preview: LinkPreview): boolean {
  const title = preview.title.trim();
  const hostname = preview.hostname.trim();
  const normalizedTitle = title.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const genericVideoTitles = ["youtube", "youtube.com", "instagram", "instagram.com", "dailymotion", "dailymotion.com"];
  return !!title && normalizedTitle !== normalizedHost && !genericVideoTitles.includes(normalizedTitle);
}

export function displayLinkTitle(preview: LinkPreview, noteTitle: string): string {
  return meaningfulTitle(preview) ? preview.title.trim() : noteTitle.trim() || preview.hostname;
}

export function mergeLinkPreview(note: Note, dynamic?: LinkPreview | null): LinkPreview | null {
  const saved = {
    title: note.preview_title || "", description: note.preview_description || "",
    image: note.preview_image || "", hostname: note.preview_hostname || "",
  };
  const hasSaved = Object.values(saved).some(Boolean);
  if (!hasSaved && !dynamic) return null;
  // Instagramの汎用タイトルだけの場合は従来のURL表示を維持する。
  if (!hasSaved && dynamic && /(^|\.)instagram\.com$/i.test(dynamic.hostname)
    && !dynamic.image && !dynamic.description && !meaningfulTitle(dynamic)) return null;
  let hostname = saved.hostname || dynamic?.hostname || "";
  if (!hostname) {
    try { hostname = new URL(note.url).hostname; } catch { /* URLのないメモにはプレビューを表示しない。 */ }
  }
  return {
    title: meaningfulTitle({ ...saved, hostname }) ? saved.title
      : dynamic && meaningfulTitle(dynamic) ? dynamic.title : note.title.trim() || hostname,
    description: saved.description || dynamic?.description || "",
    image: saved.image || dynamic?.image || "",
    hostname,
  };
}

const cache = new Map<string, Promise<LinkPreview | null>>();
const queue: Array<() => void> = [];
let active = 0;

function runNext(): void {
  while (active < 3 && queue.length) {
    active += 1;
    queue.shift()?.();
  }
}

function queuedPreview(url: string): Promise<LinkPreview | null> {
  return new Promise((resolve) => {
    queue.push(() => {
      fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
        .then(async (response) => {
          if (!response.ok) return null;
          return await response.json() as LinkPreview;
        })
        .then(resolve, () => resolve(null))
        .finally(() => {
          active -= 1;
          runNext();
        });
    });
    runNext();
  });
}

export function getLinkPreview(url: string): Promise<LinkPreview | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = queuedPreview(url);
    cache.set(url, pending);
  }
  return pending;
}
