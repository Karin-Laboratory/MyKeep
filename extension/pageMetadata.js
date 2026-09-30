export function readPageMetadata() {
  const readMeta = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const content = element?.getAttribute("content")?.trim();
      if (content) return content;
    }
    return "";
  };
  const resolveHttpUrl = (value) => {
    if (!value) return "";
    try {
      const resolved = new URL(value, location.href);
      return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : "";
    } catch {
      return "";
    }
  };
  const youtubeHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  const youtubeVideoId = (value) => {
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:"].includes(url.protocol) || !youtubeHosts.includes(url.hostname)) return null;
      const id = url.hostname === "youtu.be" ? /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
        : url.pathname === "/watch" ? url.searchParams.get("v")
          : /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch { return null; }
  };
  if (youtubeHosts.includes(location.hostname)) {
    const currentId = youtubeVideoId(location.href);
    const references = [
      readMeta(['meta[property="og:url"]', 'meta[name="og:url"]']),
      document.querySelector('link[rel~="canonical"]')?.getAttribute("href")?.trim(),
    ].filter(Boolean);
    // 一致を確認できない場合も、前動画のOG/Twitter情報を保存しない。
    if (!currentId || !references.length || references.some((value) => youtubeVideoId(value) !== currentId)) {
      return {
        title: (document.title || "").replace(/ - YouTube$/, ""),
        description: "", image: "", hostname: location.hostname, href: location.href,
      };
    }
  }
  const title = readMeta([
    'meta[property="og:title"]',
    'meta[name="og:title"]',
    'meta[property="twitter:title"]',
    'meta[name="twitter:title"]',
  ]) || document.title || "";
  const description = readMeta([
    'meta[property="og:description"]',
    'meta[name="og:description"]',
    'meta[property="twitter:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
    'meta[property="description"]',
  ]);
  const resolveFirstHttpUrl = (selectors) => {
    for (const selector of selectors) {
      const resolved = resolveHttpUrl(readMeta([selector]));
      if (resolved) return resolved;
    }
    return "";
  };
  const image = resolveFirstHttpUrl([
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="og:image:secure_url"]',
    'meta[property="og:image:url"]',
    'meta[name="og:image:url"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image:src"]',
    'meta[name="twitter:image:src"]',
  ]);
  return { title, description, image, hostname: location.hostname || "", href: location.href };
}
