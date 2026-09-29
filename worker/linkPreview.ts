const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const HTML_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

function publicWebUrl(value: string): URL | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
      || (url.port && url.port !== "80" && url.port !== "443")
      || !host.includes(".") || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function tagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attrs;
}

function metadata(html: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    if (key && !result.has(key)) result.set(key, attrs.get("content") ?? "");
  }
  return result;
}

function videoSite(hostname: string): "instagram.com" | "dailymotion.com" | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram.com";
  if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) return "dailymotion.com";
  return null;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstString).find(Boolean) ?? "";
  if (value && typeof value === "object" && "url" in value) return firstString(value.url);
  return "";
}

function videoJsonLd(html: string): { title: string; description: string; image: string } {
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (tagAttributes(script[1]).get("type")?.toLowerCase() !== "application/ld+json") continue;
    try {
      const data: unknown = JSON.parse(script[2]);
      const roots = Array.isArray(data) ? data : [data];
      for (const root of roots) {
        if (!root || typeof root !== "object") continue;
        const graph = "@graph" in root && Array.isArray(root["@graph"]) ? root["@graph"] : [];
        for (const entry of [root, ...graph]) {
          if (!entry || typeof entry !== "object" || !("@type" in entry)) continue;
          const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
          if (!types.includes("VideoObject")) continue;
          return {
            title: "name" in entry ? firstString(entry.name) : "",
            description: "description" in entry ? firstString(entry.description) : "",
            image: "thumbnailUrl" in entry ? firstString(entry.thumbnailUrl) : "image" in entry ? firstString(entry.image) : "",
          };
        }
      }
    } catch { /* 壊れたJSON-LDは通常メタデータで続行する。 */ }
  }
  return { title: "", description: "", image: "" };
}

function oEmbedLink(html: string, pageUrl: URL): URL | null {
  const site = videoSite(pageUrl.hostname);
  if (!site) return null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag);
    if (!attrs.get("rel")?.toLowerCase().split(/\s+/).includes("alternate")
      || attrs.get("type")?.toLowerCase() !== "application/json+oembed" || !attrs.get("href")) continue;
    try {
      const endpoint = publicWebUrl(new URL(attrs.get("href")!, pageUrl).toString());
      if (endpoint && videoSite(endpoint.hostname) === site) return endpoint;
    } catch { /* 壊れたURLは無視する。 */ }
  }
  return null;
}

function genericVideoTitle(title: string, pageUrl: URL): boolean {
  const site = videoSite(pageUrl.hostname);
  const normalized = title.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return !normalized || normalized === pageUrl.hostname.toLowerCase().replace(/^www\./, "")
    || (site !== null && (normalized === site || normalized === site.split(".")[0]));
}

async function readText(response: Response, limit: number, stopAtHead: boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value.slice(0, Math.max(0, limit - (bytes - value.byteLength))), { stream: true });
      if (stopAtHead && /<\/head\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

async function fetchPublicPage(target: URL, signal: AbortSignal, headers = HTML_HEADERS): Promise<{ response: Response; url: URL }> {
  let current = target;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    // Check each hop before fetching so a public URL cannot redirect to an internal host.
    const response = await fetch(current.toString(), { redirect: "manual", headers, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) throw new Error("Invalid redirect");
      const next = publicWebUrl(new URL(location, current).toString());
      if (!next) throw new Error("Unsafe redirect");
      current = next;
      continue;
    }
    const finalUrl = response.url ? publicWebUrl(response.url) : current;
    if (!finalUrl) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Unsafe response URL");
    }
    return { response, url: finalUrl };
  }
  throw new Error("Too many redirects");
}

async function discoveredOEmbed(html: string, pageUrl: URL, signal: AbortSignal): Promise<{ title: string; image: string }> {
  const endpoint = oEmbedLink(html, pageUrl);
  if (!endpoint) return { title: "", image: "" };
  try {
    const { response } = await fetchPublicPage(endpoint, signal, { ...HTML_HEADERS, Accept: "application/json" });
    if (!response.ok || !/^application\/(?:json|json\+oembed)\b/i.test(response.headers.get("Content-Type") ?? "")) {
      return { title: "", image: "" };
    }
    const data: unknown = JSON.parse(await readText(response, 32 * 1024, false));
    if (!data || typeof data !== "object") return { title: "", image: "" };
    const title = "title" in data ? firstString(data.title) : "";
    const thumbnail = "thumbnail_url" in data ? firstString(data.thumbnail_url) : "";
    const image = thumbnail ? publicWebUrl(new URL(thumbnail, endpoint).toString())?.toString() ?? "" : "";
    return { title, image };
  } catch {
    return { title: "", image: "" };
  }
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function youtubePreview(videoId: string, signal: AbortSignal): Promise<Response | null> {
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", canonical);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint.toString(), {
    redirect: "error", headers: { Accept: "application/json" }, signal,
  });
  if (!response.ok) return null;
  const data = await response.json() as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim().slice(0, 300) : "";
  if (!title) return null;
  const author = typeof data.author_name === "string" ? data.author_name.trim().slice(0, 200) : "";
  const thumbnail = typeof data.thumbnail_url === "string" ? publicWebUrl(data.thumbnail_url)?.toString() : null;
  return Response.json({
    title,
    description: author ? `YouTube · ${author}` : "",
    image: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    hostname: "www.youtube.com",
  }, { headers: { "Cache-Control": "private, max-age=3600" } });
}

function youtubeFallback(videoId: string): Response {
  return Response.json({
    title: "", description: "",
    image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    hostname: "www.youtube.com",
  }, { headers: { "Cache-Control": "private, max-age=3600" } });
}

export async function linkPreview(request: Request): Promise<Response> {
  const target = publicWebUrl(new URL(request.url).searchParams.get("url") ?? "");
  if (!target) return Response.json({ error: "URLが正しくありません。" }, { status: 400 });
  const signal = AbortSignal.timeout(9000);
  const videoId = youtubeVideoId(target);
  if (videoId) {
    try {
      const preview = await youtubePreview(videoId, AbortSignal.timeout(3500));
      if (preview) return preview;
    } catch { /* oEmbedに失敗した場合は通常のOGPを試す。 */ }
  }
  try {
    const { response, url } = await fetchPublicPage(target, signal);
    if (!response.ok || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("Content-Type") ?? "")) {
      return videoId ? youtubeFallback(videoId) : Response.json({ error: "プレビューを取得できません。" }, { status: 502 });
    }
    const html = await readText(response, MAX_HTML_BYTES, !videoSite(url.hostname));
    const meta = metadata(html);
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    let foundTitle = (meta.get("og:title") || meta.get("twitter:title") || (titleTag ? decodeEntities(titleTag[1]) : "")).trim();
    let description = (meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || "").trim();
    let imageSource = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image") || meta.get("twitter:image:src") || "";
    if (videoSite(url.hostname)) {
      const video = videoJsonLd(html);
      if (genericVideoTitle(foundTitle, url) && video.title) foundTitle = video.title;
      description ||= video.description;
      imageSource ||= video.image;
      if (genericVideoTitle(foundTitle, url) || !imageSource) {
        const embed = await discoveredOEmbed(html, url, signal);
        if (genericVideoTitle(foundTitle, url) && embed.title) foundTitle = embed.title;
        imageSource ||= embed.image;
      }
    }
    foundTitle = foundTitle.slice(0, 300);
    const title = videoId && (!foundTitle || foundTitle.toLowerCase() === url.hostname.toLowerCase())
      ? "" : foundTitle || url.hostname;
    description = description.slice(0, 500);
    let image = "";
    if (imageSource) {
      try { image = publicWebUrl(new URL(imageSource, url).toString())?.toString() ?? ""; }
      catch { /* 壊れた画像URLでもタイトルのプレビューを表示する。 */ }
    }
    return Response.json({ title, description, image: image || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ""), hostname: url.hostname }, {
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return videoId ? youtubeFallback(videoId) : Response.json({ error: "プレビューを取得できません。" }, { status: 502 });
  }
}
