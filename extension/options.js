import { captureEndpoint, hostPermissionPattern } from "./shared.js";

const form = document.getElementById("optionsForm");
const apiUrl = document.getElementById("apiUrl");
const apiKey = document.getElementById("apiKey");
const status = document.getElementById("status");
const repairProgress = document.getElementById("repairProgress");
const repairStatus = document.getElementById("repairStatus");
const repairCount = document.getElementById("repairCount");
const repairButtons = Object.fromEntries(["Check", "Start", "Pause", "Resume", "Cancel", "Retry"]
  .map(name => [name.toLowerCase(), document.getElementById(`repair${name}`)]));
let repairState = { status: "idle", failures: [] };
let repairRequestPending = false;
let configured = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

chrome.storage.local.get(["apiUrl", "apiKey"]).then((settings) => {
  apiUrl.value = settings.apiUrl ?? "";
  apiKey.value = settings.apiKey ?? "";
  configured = Boolean(settings.apiUrl && settings.apiKey);
  renderRepair();
}).catch(() => showStatus("設定を読み込めませんでした。", true));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("");
  try {
    const endpoint = captureEndpoint(apiUrl.value);
    const key = apiKey.value.trim();
    if (!key) throw new Error("API KEYを入力してください。");
    const granted = await chrome.permissions.request({ origins: [hostPermissionPattern(endpoint)] });
    if (!granted) throw new Error("API URLへの接続許可が必要です。");
    await chrome.storage.local.set({ apiUrl: endpoint, apiKey: key });
    configured = true;
    renderRepair();
    showStatus("設定を保存しました。");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "設定を保存できませんでした。", true);
  }
});

function renderRepair() {
  const running = repairState.status === "running";
  const finishing = Boolean(repairState.currentNoteId);
  const paused = repairState.status === "paused";
  repairButtons.pause.hidden = !running;
  repairButtons.cancel.hidden = !running && !paused;
  repairButtons.resume.hidden = !paused;
  repairButtons.retry.hidden = running || paused || !repairState.failures?.length;
  repairButtons.start.hidden = running || paused;
  for (const button of Object.values(repairButtons)) button.disabled = repairRequestPending || !configured;
  repairButtons.start.disabled ||= finishing;
  repairButtons.resume.disabled ||= finishing;
  repairButtons.retry.disabled ||= finishing;
  repairButtons.check.disabled ||= running;
  const names = { idle: "", running: "処理中", paused: "一時停止", cancelled: "中止しました", completed: "処理完了" };
  repairProgress.textContent = repairState.status === "idle" ? "" :
    `${names[repairState.status] ?? ""}：${repairState.processed ?? 0} / ${repairState.total ?? 0}\n成功：${repairState.success ?? 0}　失敗：${repairState.failed ?? 0}${finishing ? "\n現在の1件を終了しています。" : ""}`;
  repairStatus.textContent = !configured ? "先にAPI URLとAPI KEYを設定してください。" : repairState.error || "";
  repairStatus.classList.toggle("error", Boolean(repairState.error));
}

async function repairCommand(action) {
  if (repairRequestPending) return;
  repairRequestPending = true;
  renderRepair();
  try {
    if (["start", "resume", "retry"].includes(action)) {
      // Only explicit repair actions request broad access; ordinary capture stays activeTab-based.
      const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
      if (!granted) throw new Error("サムネイル補完にはサイトへのアクセス許可が必要です。");
    }
    const result = await chrome.runtime.sendMessage({ type: "thumbnail-repair", action });
    if (!result?.ok) throw new Error(result?.error || "処理を開始できませんでした。");
    if (result.state) repairState = result.state;
    if (Number.isSafeInteger(result.count)) repairCount.textContent = `未取得件数：${result.count}件`;
    repairRequestPending = false;
    renderRepair();
  } catch (error) {
    repairRequestPending = false;
    renderRepair();
    repairStatus.textContent = error instanceof Error ? error.message : "処理を確認できませんでした。";
    repairStatus.classList.add("error");
  }
}

repairButtons.check.addEventListener("click", () => void repairCommand("count"));
for (const action of ["start", "pause", "resume", "cancel", "retry"]) {
  repairButtons[action].addEventListener("click", () => void repairCommand(action));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.thumbnailRepairState) repairState = changes.thumbnailRepairState.newValue ?? { status: "idle", failures: [] };
  if (changes.apiUrl || changes.apiKey) {
    void chrome.storage.local.get(["apiUrl", "apiKey"]).then(config => {
      configured = Boolean(config.apiUrl && config.apiKey); renderRepair();
    });
  }
  renderRepair();
});
renderRepair();
void chrome.runtime.sendMessage({ type: "thumbnail-repair", action: "state" }).then(result => {
  if (result?.ok && result.state) { repairState = result.state; renderRepair(); }
}).catch(() => {
  repairStatus.textContent = "拡張を再読み込みしてから設定を開き直してください。";
});
