/* =========================================================
   Schedule from Pic — App entry / state machine
   Wires the UI (index.html) to the modules
   (providers.js, prompt.js, export.js, ocr.js, parser.js).
   ========================================================= */

import { PROVIDERS, extractWithFailover, downscaleImage } from "./providers.js";
import { ocrExtract } from "./ocr.js";
import { generateICS, downloadICS, googleCalendarURL } from "./export.js";

/* ---------- State ---------- */
const state = {
  imageFile: null,        // File
  imageDataUrl: null,     // downscaled base64
  event: null,            // { title, startDateTime, endDateTime, location, description, rawText, confidence }
  abortController: null,  // for cancelling in-flight extract
  providerUsed: null,
};

/* ---------- Settings (localStorage) ---------- */
const SETTINGS_KEY = "schedule-from-pic:settings:v1";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function getSettings() {
  const s = loadSettings();
  return {
    keys: {
      gemini:      s.gemini || "",
      groq:        s.groq   || "",
      huggingface: s.huggingface || "",
    },
    defaultProvider: s.defaultProvider || "gemini",
    theme: s.theme || "auto",
  };
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "auto") {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", theme);
  }
}
function initTheme() {
  applyTheme(getSettings().theme);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getSettings().theme === "auto") applyTheme("auto");
  });
}

/* ---------- Screen routing ---------- */
const SCREENS = ["home", "preview", "extracting", "review", "export"];

function show(name) {
  for (const s of SCREENS) {
    const el = document.querySelector(`.screen[data-screen="${s}"]`);
    if (!el) continue;
    if (s === name) {
      el.hidden = false;
      el.style.animation = "none";
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight;
      el.style.animation = "";
    } else {
      el.hidden = true;
    }
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => { el.hidden = true; }, 240);
  }, ms);
}

/* ---------- Extraction ---------- */
async function handleFileChosen(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("Please pick an image file");
    return;
  }
  state.imageFile = file;
  const previewUrl = URL.createObjectURL(file);
  const img = document.getElementById("preview-image");
  img.src = previewUrl;
  img.onload = () => URL.revokeObjectURL(previewUrl);
  show("preview");
}

async function startExtraction() {
  if (!state.imageFile) { toast("Pick a photo first"); return; }
  const settings = getSettings();
  const hasAnyKey = Object.values(settings.keys).some((k) => k.trim());
  const online = navigator.onLine;

  show("extracting");
  setExtractingStatus("Preparing image…");
  state.abortController = new AbortController();

  try {
    state.imageDataUrl = await downscaleImage(state.imageFile);

    let event, providerUsed = null;
    if (online && hasAnyKey) {
      const result = await extractWithFailover(
        settings.defaultProvider,
        state.imageDataUrl,
        settings.keys,
        {
          signal: state.abortController.signal,
          onProviderTry: (name) => setExtractingStatus(`Trying ${name}…`),
          onStatus: (msg) => setExtractingStatus(msg),
        }
      );
      event = result.event;
      providerUsed = result.provider;
    } else if (!online) {
      setExtractingStatus("Offline — using on-device OCR (slower, less accurate)");
      event = await ocrExtract(state.imageDataUrl, { onStatus: (m) => setExtractingStatus(m) });
      providerUsed = "On-device (Tesseract)";
    } else {
      throw new Error("No API keys configured. Tap the ⚙ icon to add a free key.");
    }

    state.event = event;
    state.providerUsed = providerUsed;
    populateReview(event);
    show("review");
  } catch (err) {
    if (err.name === "AbortError") {
      show("preview");
      return;
    }
    console.error(err);
    show("preview");
    toast(err.message || "Extraction failed", 4000);
  }
}

function setExtractingStatus(msg) {
  const el = document.getElementById("extracting-status");
  if (el) el.textContent = msg;
}

function cancelExtraction() {
  state.abortController?.abort();
}

/* ---------- Review form ---------- */
function populateReview(event) {
  const form = document.getElementById("event-form");
  form.elements.title.value = event.title || "";
  form.elements.startDateTime.value = toLocalInputValue(event.startDateTime);
  form.elements.endDateTime.value   = toLocalInputValue(event.endDateTime);
  form.elements.location.value = event.location || "";
  form.elements.description.value = event.description || "";
  document.getElementById("raw-text").textContent = event.rawText || "";

  for (const el of form.querySelectorAll(".conf")) {
    const field = el.dataset.conf;
    const level = event.confidence?.[field];
    if (level) el.setAttribute("data-level", level);
    else el.removeAttribute("data-level");
  }
  updateMapsLink();
}

function readReviewForm() {
  const form = document.getElementById("event-form");
  return {
    title: form.elements.title.value.trim(),
    startDateTime: fromLocalInputValue(form.elements.startDateTime.value),
    endDateTime:   fromLocalInputValue(form.elements.endDateTime.value),
    location: form.elements.location.value.trim(),
    description: form.elements.description.value.trim(),
    allDay: false,
  };
}

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function updateMapsLink() {
  const loc = document.getElementById("event-form").elements.location.value.trim();
  const link = document.getElementById("maps-link");
  if (loc) {
    link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

/* ---------- Export ---------- */
function goToExport() {
  const event = readReviewForm();
  if (!event.title)   { toast("Title is required"); return; }
  if (!event.startDateTime) { toast("Start date/time is required"); return; }
  if (!event.endDateTime) {
    event.endDateTime = new Date(new Date(event.startDateTime).getTime() + 60 * 60 * 1000).toISOString();
  }
  state.event = event;

  document.getElementById("export-title").textContent  = event.title;
  document.getElementById("export-when").textContent   = formatRange(event.startDateTime, event.endDateTime);
  document.getElementById("export-where").textContent  = event.location || "No location";

  document.getElementById("export-google").href = googleCalendarURL(event);
  show("export");
}

function formatRange(startIso, endIso) {
  const s = new Date(startIso), e = new Date(endIso);
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
  return `${fmt.format(s)} → ${fmt.format(e)}`;
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.event, null, 2));
    toast("JSON copied to clipboard");
  } catch {
    toast("Couldn't copy — your browser blocked clipboard access");
  }
}

/* ---------- Settings drawer ---------- */
function openSettings() {
  const drawer = document.getElementById("settings-drawer");
  const s = loadSettings();
  // Populate fields from current settings
  document.querySelector('input[name="key-gemini"]').value      = s.gemini      || "";
  document.querySelector('input[name="key-groq"]').value        = s.groq        || "";
  document.querySelector('input[name="key-huggingface"]').value = s.huggingface || "";
  const dp = s.defaultProvider || "gemini";
  for (const r of document.querySelectorAll('input[name="default-provider"]')) {
    r.checked = (r.value === dp);
  }
  const th = s.theme || "auto";
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = (r.value === th);
  }
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
}
function closeSettings() {
  const drawer = document.getElementById("settings-drawer");
  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
}
function commitSettings() {
  const next = {
    gemini:      document.querySelector('input[name="key-gemini"]').value.trim(),
    groq:        document.querySelector('input[name="key-groq"]').value.trim(),
    huggingface: document.querySelector('input[name="key-huggingface"]').value.trim(),
    defaultProvider:
      (document.querySelector('input[name="default-provider"]:checked') || {}).value || "gemini",
    theme:
      (document.querySelector('input[name="theme"]:checked') || {}).value || "auto",
  };
  saveSettings(next);
  applyTheme(next.theme);
}

function clearAllData() {
  if (!confirm("This will delete your API keys and reset all settings. Continue?")) return;
  localStorage.removeItem(SETTINGS_KEY);
  toast("All data cleared");
  closeSettings();
  setTimeout(() => location.reload(), 600);
}

/* ---------- Event wiring (delegation) ---------- */
function startOver() {
  state.imageFile = null;
  state.imageDataUrl = null;
  state.event = null;
  state.providerUsed = null;
  document.getElementById("preview-image").src = "";
  show("home");
}

function bindEvents() {
  // Camera + library file inputs
  const fileCam = document.getElementById("file-camera");
  const fileLib = document.getElementById("file-library");
  fileCam.addEventListener("change", (e) => {
    handleFileChosen(e.target.files?.[0]);
    e.target.value = ""; // allow re-selecting same file
  });
  fileLib.addEventListener("change", (e) => {
    handleFileChosen(e.target.files?.[0]);
    e.target.value = "";
  });

  // Global click delegation for data-action
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    switch (action) {
      case "take-photo":       fileCam.click(); break;
      case "choose-photo":     fileLib.click(); break;
      case "extract":          startExtraction(); break;
      case "cancel-extract":   cancelExtraction(); break;
      case "back-home":        startOver(); break;
      case "back-preview":     show("preview"); break;
      case "back-review":      show("review"); break;
      case "re-extract":       startExtraction(); break;
      case "show-export":      goToExport(); break;
      case "download-ics":     downloadICS(state.event); toast("Calendar file downloaded"); break;
      case "copy-json":        copyJson(); break;
      case "start-over":       startOver(); break;
      case "open-settings":    openSettings(); break;
      case "close-settings":   commitSettings(); closeSettings(); break;
      case "clear-all":        clearAllData(); break;
    }
  });

  // Update maps link as user types
  document.getElementById("event-form").addEventListener("input", (e) => {
    if (e.target.name === "location") updateMapsLink();
  });

  // Persist settings as user types
  for (const sel of ['input[name="key-gemini"]', 'input[name="key-groq"]', 'input[name="key-huggingface"]']) {
    document.querySelector(sel)?.addEventListener("change", commitSettings);
  }
  for (const sel of ['input[name="default-provider"]', 'input[name="theme"]']) {
    document.querySelectorAll(sel).forEach((r) => r.addEventListener("change", commitSettings));
  }

  // Service worker (PWA install + offline shell)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW register failed", e));
  }
}

/* ---------- Boot ---------- */
initTheme();
bindEvents();
show("home");
