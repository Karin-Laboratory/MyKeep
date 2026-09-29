const MAX_HTML_BYTES = 256 * 1024;

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

function metadata(html: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    if (key && !result.has(key)) result.set(key, attrs.get("content") ?? "");
  }
  return result;
}

async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value.slice(0, Math.max(0, MAX_HTML_BYTES - (bytes - value.byteLength))), { stream: true });
      if (/<\/head\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

export async function linkPreview(request: Request): Promise<Response> {
  const target = publicWebUrl(new URL(request.url).searchParams.get("url") ?? "");
  if (!target) return Response.json({ error: "URLが正しくありません。" }, { status: 400 });
  try {
    const response = await fetch(target.toString(), {
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("Content-Type") ?? "")) {
      return Response.json({ error: "プレビューを取得できません。" }, { status: 502 });
    }
    const html = await readHead(response);
    const meta = metadata(html);
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    const title = (meta.get("og:title") || (titleTag ? decodeEntities(titleTag[1]) : "") || target.hostname).trim().slice(0, 300);
    const description = (meta.get("og:description") || meta.get("description") || "").trim().slice(0, 500);
    const imageSource = meta.get("og:image") || meta.get("og:image:url") || "";
    let image = "";
    if (imageSource) {
      try { image = publicWebUrl(new URL(imageSource, target).toString())?.toString() ?? ""; }
      catch { /* 壊れた画像URLでもタイトルのプレビューを表示する。 */ }
    }
    return Response.json({ title, description, image, hostname: target.hostname }, {
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return Response.json({ error: "プレビューを取得できません。" }, { status: 502 });
  }
}
