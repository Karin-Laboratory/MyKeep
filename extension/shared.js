export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export function captureEndpoint(value) {
  const url = new URL(value.trim());
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("API URLはHTTPSを指定してください。ローカル開発時のみHTTPを使えます。");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/capture") {
    throw new Error("API URLは /api/capture まで含めて指定してください。");
  }
  return url.href;
}

export function hostPermissionPattern(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}
