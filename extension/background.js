import { captureEndpoint, hostPermissionPattern } from "./shared.js";
import { readPageMetadata } from "./pageMetadata.js";

const STATE_KEY = "thumbnailRepairState";
const SESSION_KEY = "thumbnailRepairSession";
const ALARM = "mykeep-thumbnail-repair";
const LOAD_TIMEOUT = 12_000;
const SETTLE_TIME = 1_000;
const INTERVAL = 750;
const API_TIMEOUT = 15_000;
const emptyState = () => ({ status: "idle", total: 0, processed: 0, success: 0, failed: 0,
  cursor: null, currentNoteId: null, pendingNote: null, failures: [], mode: "missing", runId: null, apiUrl: "", nextAt: 0, error: "" });
let state, session, busy = false, controller = null, nextTimer = null;
let writes = Promise.resolve(), page = [], metadataCache = new Map();

function persist() {
  const snapshot = structuredClone(state);
  // Controls and a finishing note may both save; keep their writes in order.
  writes = writes.catch(() => {}).then(() => chrome.storage.local.set({ [STATE_KEY]: snapshot }));
  return writes;
}

async function saveSession() {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}

async function closeOwnedTab() {
  if (!Number.isInteger(session?.tabId)) return;
  const id = session.tabId;
  try { await chrome.tabs.remove(id); }
  catch {
    // A user may already have closed this task's tab. Never search for other tabs.
    let existing;
    try { existing = await chrome.tabs.get(id); } catch { /* Already closed. */ }
    if (existing) throw new Error("作業タブを閉じられません。タブを閉じてから再開してください。");
  }
  session.tabId = null;
  await saveSession();
}

async function arm() {
  if (state.status !== "running") return;
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

async function disarm() {
  clearTimeout(nextTimer);
  nextTimer = null;
  await chrome.alarms.clear(ALARM);
}

function scheduleNext() {
  if (state.status !== "running") return;
  clearTimeout(nextTimer);
  // Short delay for normal operation; the recurring alarm survives worker suspension.
  nextTimer = setTimeout(() => { void step().catch(pauseWithError); }, Math.max(0, state.nextAt - Date.now()));
}

async function pauseWithError() {
  state.status = "paused";
  state.error = "処理を一時停止しました。API設定・接続・作業タブを確認して再開してください。";
  await disarm();
  await persist();
}

const ready = (async () => {
  const [stored, transient] = await Promise.all([
    chrome.storage.local.get(STATE_KEY), chrome.storage.session.get(SESSION_KEY),
  ]);
  state = { ...emptyState(), ...stored[STATE_KEY] };
  session = transient[SESSION_KEY] ?? { runId: null, tabId: null };
  // session storage survives worker suspension but is cleared on browser restart.
  if (state.status === "running" && session.runId !== state.runId) state.status = "paused";
  try { await closeOwnedTab(); }
  catch { state.status = "paused"; state.error = "前回の作業タブを閉じてから再開してください。"; }
  state.currentNoteId = null;
  await persist();
  if (state.status === "running") await arm();
  else await disarm();
})();

async function settings() {
  const config = await chrome.storage.local.get(["apiUrl", "apiKey"]);
  if (!config.apiUrl || !config.apiKey) throw new Error("先にAPI URLとAPI KEYを設定してください。");
  const endpoint = captureEndpoint(config.apiUrl);
  if (!await chrome.permissions.contains({ origins: [hostPermissionPattern(endpoint)] })) {
    throw new Error("API URLへの接続許可を設定画面で保存してください。");
  }
  return { endpoint, key: config.apiKey };
}

async function api(params, body, signal) {
  const config = await settings();
  if ((body || params?.mode === "missing-previews" || state.status === "running") && state.apiUrl !== config.endpoint) {
    throw new Error("API設定が変更されました。");
  }
  const endpoint = new URL(config.endpoint);
  for (const [key, value] of Object.entries(params ?? {})) endpoint.searchParams.set(key, value);
  const response = await fetch(endpoint.href, {
    method: body ? "PUT" : "GET", headers: { Authorization: `Bearer ${config.key}`,
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), credentials: "omit", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT)]) : AbortSignal.timeout(API_TIMEOUT),
  });
  if (!response.ok) throw new Error("api_update_failed");
  return response.json();
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function sameSite(before, after) {
  const normalize = host => host.toLowerCase().replace(/^www\./, "");
  const youtube = new Set(["youtube.com", "m.youtube.com", "youtu.be"]);
  const a = normalize(before), b = normalize(after);
  return a === b || (youtube.has(a) && youtube.has(b));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function waitForLoad(tabId, signal) {
  return new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      signal.removeEventListener("abort", abort);
      error ? reject(new Error(error)) : resolve();
    };
    const updated = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const removed = id => { if (id === tabId) done("script_failed"); };
    const abort = () => done("cancelled");
    const timer = setTimeout(() => done("load_timeout"), LOAD_TIMEOUT);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") done(); }).catch(() => done("script_failed"));
  });
}

async function readMetadata(note, signal) {
  const original = httpUrl(note.url);
  if (!original) throw new Error("invalid_url");
  if (metadataCache.has(original.href)) return metadataCache.get(original.href);
  if (!await chrome.permissions.contains({ origins: [hostPermissionPattern(original.href)] })) throw new Error("permission_denied");
  let tab;
  try { tab = await chrome.tabs.create({ url: original.href, active: false }); }
  catch { throw new Error("tab_create_failed"); }
  if (!Number.isInteger(tab?.id)) throw new Error("tab_create_failed");
  session.tabId = tab.id;
  try {
    await saveSession();
    // A background page may play audio; mute this task's tab only.
    await chrome.tabs.update(tab.id, { muted: true });
    await waitForLoad(tab.id, signal);
    await delay(SETTLE_TIME, signal);
    const finalTab = await chrome.tabs.get(tab.id);
    const finalUrl = httpUrl(finalTab.url);
    if (finalUrl && !sameSite(original.hostname, finalUrl.hostname)) throw new Error("redirect_mismatch");
    let injected;
    try {
      const result = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageMetadata }),
        delay(3_000, signal).then(() => { throw new Error("script_failed"); }),
      ]);
      injected = result?.[0]?.result;
    } catch { throw new Error(signal.aborted ? "cancelled" : "script_failed"); }
    const actual = httpUrl(injected?.href);
    if (!actual || !sameSite(original.hostname, actual.hostname)) throw new Error("redirect_mismatch");
    const image = httpUrl(injected?.image);
    if (!image || image.href.length > 2000) throw new Error("no_image");
    const metadata = { preview_title: typeof injected.title === "string" ? injected.title.slice(0, 300) : "",
      preview_description: typeof injected.description === "string" ? injected.description.slice(0, 500) : "",
      preview_image: image.href, preview_hostname: actual.hostname.slice(0, 255) };
    if (metadataCache.size >= 100) metadataCache.delete(metadataCache.keys().next().value);
    metadataCache.set(original.href, metadata);
    return metadata;
  } finally { await closeOwnedTab(); }
}

async function nextNote() {
  // Replay an interrupted update idempotently, even if it already left the missing list.
  if (state.pendingNote) return state.pendingNote;
  if (state.mode === "retry") {
    const failure = state.failures.find(item => item.attemptRun !== state.runId);
    return failure ? { id: failure.noteId, url: failure.url } : null;
  }
  if (!page.length) {
    const result = await api({ mode: "missing-previews", limit: "50", ...(state.cursor ? { cursor: state.cursor } : {}) });
    if (!Array.isArray(result.notes) || result.notes.length > 50) throw new Error("一覧を確認できません。");
    if (result.notes.some(note => typeof note.id !== "string" || typeof note.url !== "string" || (state.cursor && note.id <= state.cursor))) {
      throw new Error("一覧のカーソルを確認できません。");
    }
    page = result.notes;
  }
  return page.shift() ?? null;
}

async function step() {
  await ready;
  if (busy || state.status !== "running") return;
  if (Date.now() < state.nextAt) { scheduleNext(); return; }
  busy = true;
  let note;
  try {
    // If cleanup previously failed, do not open a second tab.
    await closeOwnedTab();
    note = await nextNote();
    if (state.status !== "running") { page = []; return; }
    if (!note) { state.status = "completed"; await disarm(); await persist(); return; }
    state.currentNoteId = note.id;
    state.pendingNote = note;
    await persist();
    if (state.status === "cancelled") return;
    controller = new AbortController();
    let reason = null;
    try {
      const metadata = note.metadata ?? await readMetadata(note, controller.signal);
      if (state.status === "cancelled") throw new Error("cancelled");
      state.pendingNote = { id: note.id, url: note.url, metadata };
      await persist();
      await api(null, { mode: "fill-preview", note_id: note.id, source_url: note.url, ...metadata }, controller.signal);
    } catch (error) {
      if (state.status === "cancelled") return;
      const known = ["permission_denied", "tab_create_failed", "load_timeout", "script_failed", "no_image", "api_update_failed", "invalid_url", "redirect_mismatch"];
      reason = known.includes(error.message) ? error.message : "api_update_failed";
    }
    // Never commit a cursor until the owned tab is closed and the outcome saved.
    await closeOwnedTab();
    if (state.status === "cancelled") return;
    state.processed += 1;
    if (reason) {
      state.failed += 1;
      const failure = { noteId: note.id, url: note.url, reason, attemptRun: state.runId };
      const index = state.failures.findIndex(item => item.noteId === note.id);
      if (index >= 0) state.failures[index] = failure;
      else state.failures.push(failure);
    } else {
      state.success += 1;
      state.failures = state.failures.filter(item => item.noteId !== note.id);
    }
    if (state.mode === "missing") state.cursor = note.id;
    state.currentNoteId = null;
    state.pendingNote = null;
    state.nextAt = Date.now() + INTERVAL;
    await persist();
  } catch {
    // A list/cleanup/storage error cannot safely advance the cursor.
    page = [];
    await pauseWithError();
  } finally {
    controller = null;
    try { await closeOwnedTab(); } catch { await pauseWithError(); }
    state.currentNoteId = null;
    await persist();
    busy = false;
    scheduleNext();
  }
}

async function command(action) {
  await ready;
  if (action === "state") return { state };
  if (action === "count") {
    const result = await api({ mode: "missing-preview-count" });
    if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error("未取得件数を確認できません。");
    return { count: result.count };
  }
  if (action === "pause" || action === "cancel") {
    state.status = action === "pause" ? "paused" : "cancelled";
    await disarm();
    if (action === "cancel") controller?.abort();
    await persist();
    if (action === "cancel" && !busy) await closeOwnedTab();
    return { state };
  }
  if (!["start", "resume", "retry"].includes(action)) throw new Error("操作を確認してください。");
  if (busy || state.status === "running") throw new Error("処理中です。現在の1件が終了するまでお待ちください。");
  const config = await settings();
  if (!await chrome.permissions.contains({ origins: ["https://*/*", "http://*/*"] })) throw new Error("サイトへのアクセス許可が必要です。");
  if (action === "resume") {
    if (state.status !== "paused") throw new Error("再開する処理がありません。");
    if (state.apiUrl !== config.endpoint) throw new Error("前回と同じAPI URLを設定してから再開してください。");
  } else if (action === "retry") {
    if (!state.failures.length) throw new Error("再試行する失敗はありません。");
    if (state.apiUrl !== config.endpoint) throw new Error("前回と同じAPI URLを設定してください。");
    state = { ...state, pendingNote: null, mode: "retry", total: state.failures.length, processed: 0, success: 0, failed: 0, runId: crypto.randomUUID() };
  } else {
    const result = await api({ mode: "missing-preview-count" });
    if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error("未取得件数を確認できません。");
    state = { ...emptyState(), total: result.count, runId: crypto.randomUUID(), apiUrl: config.endpoint };
  }
  await closeOwnedTab();
  state.status = "running"; state.error = ""; state.currentNoteId = null; state.nextAt = 0;
  session = { runId: state.runId, tabId: null };
  page = []; metadataCache.clear();
  await saveSession(); await persist(); await arm();
  scheduleNext();
  return { state };
}

// Serialize control messages independently of the short per-note worker.
let commands = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "thumbnail-repair") return;
  commands = commands.catch(() => {}).then(() => command(message.action));
  void commands.then(result => respond({ ok: true, ...result }), error => respond({ ok: false,
    error: error.message === "api_update_failed" ? "APIへの接続を確認してください。" : error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void step().catch(pauseWithError);
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(async () => {
    if (state.status === "running") state.status = "paused";
    await disarm(); await persist();
  }).catch(() => {});
});
void ready.catch(() => {});
