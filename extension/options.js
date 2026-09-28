import { captureEndpoint, hostPermissionPattern } from "./shared.js";

const form = document.getElementById("optionsForm");
const apiUrl = document.getElementById("apiUrl");
const apiKey = document.getElementById("apiKey");
const status = document.getElementById("status");

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

chrome.storage.local.get(["apiUrl", "apiKey"]).then((settings) => {
  apiUrl.value = settings.apiUrl ?? "";
  apiKey.value = settings.apiKey ?? "";
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
    showStatus("設定を保存しました。");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "設定を保存できませんでした。", true);
  }
});
