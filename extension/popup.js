import { captureEndpoint, IMAGE_TYPES, MAX_IMAGE_BYTES } from "./shared.js";

const form = document.getElementById("captureForm");
const title = document.getElementById("title");
const url = document.getElementById("url");
const body = document.getElementById("body");
const imageFile = document.getElementById("imageFile");
const imagePreview = document.getElementById("imagePreview");
const previewImage = document.getElementById("previewImage");
const imageName = document.getElementById("imageName");
const status = document.getElementById("status");
const save = document.getElementById("save");
let selectedImage = null;
let previewUrl = null;

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function clearImage() {
  selectedImage = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewImage.removeAttribute("src");
  imagePreview.hidden = true;
  imageFile.value = "";
}

function setImage(file) {
  if (!IMAGE_TYPES.includes(file.type.toLowerCase())) {
    showStatus("JPEG・PNG・WebP・GIF・AVIF の画像を選んでください。", true);
    return;
  }
  if (!file.size || file.size > MAX_IMAGE_BYTES) {
    showStatus("画像は1枚20MB以下にしてください。", true);
    return;
  }
  clearImage();
  selectedImage = file;
  previewUrl = URL.createObjectURL(file);
  previewImage.src = previewUrl;
  imageName.textContent = file.name || "貼り付けた画像";
  imagePreview.hidden = false;
  showStatus("");
}

chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
  title.value = (tab?.title ?? "").slice(0, 300);
  url.value = tab?.url ?? "";
  if (!/^https?:\/\//.test(url.value)) {
    showStatus("このページのURLは保存できません。", true);
  } else {
    save.disabled = false;
  }
}).catch(() => {
  save.disabled = true;
  showStatus("現在のページを読み取れませんでした。", true);
});

document.getElementById("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("removeImage").addEventListener("click", clearImage);
imageFile.addEventListener("change", () => {
  const file = imageFile.files?.[0];
  if (file) setImage(file);
  imageFile.value = "";
});
document.addEventListener("paste", (event) => {
  const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (file) {
    event.preventDefault();
    setImage(file);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (save.disabled) return;
  save.disabled = true;
  showStatus("保存中…");
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (!settings.apiUrl || !settings.apiKey) throw new Error("設定で API URL と API KEY を保存してください。");
    const endpoint = captureEndpoint(settings.apiUrl);
    const pageUrl = new URL(url.value);
    if (!/^https?:$/.test(pageUrl.protocol) || url.value.length > 2000) {
      throw new Error("このページのURLは保存できません。");
    }

    const data = new FormData();
    data.set("title", title.value);
    data.set("url", url.value);
    data.set("body", body.value);
    if (selectedImage) data.set("image", selectedImage, selectedImage.name || "pasted.png");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: data,
      credentials: "omit",
      redirect: "error",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存できませんでした。");
    body.value = "";
    clearImage();
    showStatus("保存しました。");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "送信できませんでした。", true);
  } finally {
    save.disabled = !/^https?:\/\//.test(url.value);
  }
});
