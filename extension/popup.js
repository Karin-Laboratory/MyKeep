import { captureEndpoint, IMAGE_TYPES, MAX_IMAGE_BYTES, noteUrlFromCaptureEndpoint } from "./shared.js";
import { readPageMetadata } from "./pageMetadata.js";

const MAX_LABEL_SELECTIONS = 50;

const form = document.getElementById("captureForm");
const title = document.getElementById("title");
const url = document.getElementById("url");
const body = document.getElementById("body");
const pinned = document.getElementById("pinned");
const labelPicker = document.querySelector(".label-picker");
const labelToggle = document.getElementById("labelToggle");
const labelOptions = document.getElementById("labelOptions");
const selectedLabelsElement = document.getElementById("selectedLabels");
const labelStatus = document.getElementById("labelStatus");
const imageFile = document.getElementById("imageFile");
const imagePreview = document.getElementById("imagePreview");
const previewImage = document.getElementById("previewImage");
const imageName = document.getElementById("imageName");
const status = document.getElementById("status");
const save = document.getElementById("save");
const openNote = document.getElementById("openNote");
let selectedImage = null;
let previewUrl = null;
let availableLabels = [];
let selectedLabels = [];
let savedNoteUrl = "";
let pagePreview = { title: "", description: "", image: "", hostname: "" };
let titleEdited = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function showLabelStatus(message) {
  labelStatus.textContent = message;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pageHostname(value) {
  try {
    const parsed = new URL(value);
    return isHttpUrl(value) && parsed.hostname.length <= 255 ? parsed.hostname : "";
  } catch {
    return "";
  }
}

function setSaveEnabled() {
  save.disabled = !isHttpUrl(url.value) || url.value.length > 2000;
}

function limitText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function previewText(value, maxLength) {
  // Use single-line metadata so multipart newline conversion cannot exceed the limit.
  return typeof value === "string" ? value.replace(/\r\n|\r|\n/g, " ").trim().slice(0, maxLength) : "";
}

function previewImageUrl(value) {
  if (typeof value !== "string") return "";
  const image = value.trim();
  return image.length <= 2000 && isHttpUrl(image) ? image : "";
}

function labelKey(value) {
  return value.trim().normalize("NFC").toLowerCase();
}

function normalizeLabels(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().normalize("NFC");
    if (!name || name.length > 100) continue;
    const key = labelKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function renderSelectedLabels() {
  selectedLabelsElement.replaceChildren();
  for (const name of selectedLabels) {
    const chip = document.createElement("span");
    chip.className = "selected-label";
    chip.append(document.createTextNode(name));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.setAttribute("aria-label", `${name}を解除`);
    remove.textContent = "×";
    remove.addEventListener("click", () => toggleLabel(name, false));
    chip.append(remove);
    selectedLabelsElement.append(chip);
  }
  labelToggle.textContent = selectedLabels.length ? `ラベル（${selectedLabels.length}件）` : "ラベルを選択";
}

function updateLabelOptionState() {
  const selected = new Set(selectedLabels.map(labelKey));
  labelOptions.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const input = checkbox;
    const key = labelKey(input.value);
    input.checked = selected.has(key);
    input.disabled = selectedLabels.length >= MAX_LABEL_SELECTIONS && !input.checked;
  });
}

function toggleLabel(name, checked) {
  const key = labelKey(name);
  const index = selectedLabels.findIndex((label) => labelKey(label) === key);
  if (checked) {
    if (index >= 0) return;
    if (selectedLabels.length >= MAX_LABEL_SELECTIONS) return;
    selectedLabels = [...selectedLabels, name];
  } else if (index >= 0) {
    selectedLabels = selectedLabels.filter((_, currentIndex) => currentIndex !== index);
  }
  renderSelectedLabels();
  updateLabelOptionState();
}

function renderLabelOptions() {
  labelOptions.replaceChildren();
  for (const name of availableLabels) {
    const option = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.addEventListener("change", () => toggleLabel(name, checkbox.checked));
    option.append(checkbox, document.createTextNode(name));
    labelOptions.append(option);
  }
  labelToggle.disabled = availableLabels.length === 0;
  if (!availableLabels.length) {
    labelOptions.hidden = true;
    labelToggle.setAttribute("aria-expanded", "false");
  }
  updateLabelOptionState();
  renderSelectedLabels();
}

async function loadLabels() {
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (!settings.apiUrl || !settings.apiKey) return;
    const endpoint = captureEndpoint(settings.apiUrl);
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      credentials: "omit",
      redirect: "error",
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok || !result || !Array.isArray(result.labels)) {
      throw new Error("labels_unavailable");
    }
    availableLabels = normalizeLabels(result.labels.map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && typeof value.name === "string") return value.name;
      return "";
    }));
    renderLabelOptions();
    if (!availableLabels.length) showLabelStatus("既存ラベルはありません。");
  } catch {
    showLabelStatus("既存ラベルを読み込めませんでした。");
  }
}

async function loadPage() {
  titleEdited = false;
  title.value = "";
  url.value = "";
  body.value = "";
  pinned.checked = false;
  pagePreview = { title: "", description: "", image: "", hostname: "" };
  hideSavedNoteLink();
  showStatus("");
  selectedLabels = [];
  renderSelectedLabels();
  updateLabelOptionState();
  labelOptions.hidden = true;
  labelToggle.setAttribute("aria-expanded", "false");
  clearImage();
  save.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabTitle = limitText(typeof tab?.title === "string" ? tab.title : "", 300);
    if (!titleEdited) title.value = tabTitle;
    url.value = typeof tab?.url === "string" ? tab.url : "";
    pagePreview = { title: tabTitle, description: "", image: "", hostname: pageHostname(url.value) };
    save.disabled = true;
    if (!tab?.id || !isHttpUrl(url.value)) {
      setSaveEnabled();
      return;
    }

    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageMetadata });
      const metadata = injected?.result;
      if (metadata && typeof metadata === "object") {
        if (isHttpUrl(metadata.href)) url.value = metadata.href;
        const metadataTitle = limitText(metadata.title, 300);
        const metadataDescription = previewText(metadata.description, 500);
        const metadataImage = previewImageUrl(metadata.image);
        const metadataHostname = pageHostname(url.value);
        if (!titleEdited && typeof metadata.title === "string") title.value = metadataTitle;
        pagePreview = {
          title: metadataTitle || pagePreview.title,
          description: metadataDescription,
          image: metadataImage,
          hostname: metadataHostname || pageHostname(url.value),
        };
      }
    } catch {
      // Restricted pages and pages that change during injection still keep the tab title and URL.
    }
    setSaveEnabled();
  } catch {
    save.disabled = true;
    showStatus("現在のページを読み取れませんでした。", true);
  }
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

function hideSavedNoteLink() {
  savedNoteUrl = "";
  openNote.hidden = true;
}

labelToggle.addEventListener("click", () => {
  if (labelToggle.disabled) return;
  const expanded = labelToggle.getAttribute("aria-expanded") === "true";
  labelToggle.setAttribute("aria-expanded", String(!expanded));
  labelOptions.hidden = expanded;
});
document.addEventListener("click", (event) => {
  if (!labelPicker.contains(event.target)) {
    labelToggle.setAttribute("aria-expanded", "false");
    labelOptions.hidden = true;
  }
});

title.addEventListener("input", () => { titleEdited = true; });

void loadPage();
void loadLabels();

document.getElementById("removeImage").addEventListener("click", clearImage);
openNote.addEventListener("click", async () => {
  if (!savedNoteUrl) return;
  try {
    await chrome.tabs.create({ url: savedNoteUrl });
  } catch {
    showStatus("MyKeepを開けませんでした。", true);
  }
});
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
  hideSavedNoteLink();
  showStatus("保存中…");
  try {
    const settings = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (!settings.apiUrl || !settings.apiKey) throw new Error("設定で API URL と API KEY を保存してください。");
    const endpoint = captureEndpoint(settings.apiUrl);
    if (!isHttpUrl(url.value) || url.value.length > 2000) {
      throw new Error("このページのURLは保存できません。");
    }

    const data = new FormData();
    data.set("title", limitText(title.value, 300));
    data.set("url", url.value);
    data.set("body", body.value);
    data.set("pinned", pinned.checked ? "true" : "false");
    data.set("labels", JSON.stringify(selectedLabels));
    data.set("preview_title", previewText(pagePreview.title || title.value, 300));
    data.set("preview_description", previewText(pagePreview.description, 500));
    data.set("preview_image", previewImageUrl(pagePreview.image));
    data.set("preview_hostname", pageHostname(url.value));
    if (selectedImage) data.set("image", selectedImage, selectedImage.name || "pasted.png");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: data,
      credentials: "omit",
      redirect: "error",
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok) throw new Error(result?.error || "保存できませんでした。");
    body.value = "";
    clearImage();
    const noteId = result?.note?.id;
    if (typeof noteId === "string" && noteId.trim()) {
      try {
        savedNoteUrl = noteUrlFromCaptureEndpoint(endpoint, noteId);
        openNote.hidden = false;
      } catch {
        hideSavedNoteLink();
      }
    }
    showStatus("保存しました。");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "送信できませんでした。", true);
  } finally {
    setSaveEnabled();
  }
});
