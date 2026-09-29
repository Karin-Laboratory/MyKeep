export interface LinkPreview {
  title: string;
  description: string;
  image: string;
  hostname: string;
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
