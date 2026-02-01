/* Neverending Story PWA – app.js (Library + Settings + iOS-safe speech controls)
   Fixes:
   - “Repeats chapter 1” bug: speakToken + hard cancel + delayed speak
   - Voice reverting robotic: reload voices if missing, wait for voices
   - Pause/Resume/Stop/Replay more reliable on iOS
*/

const LS_KEY = "nes_campaigns_v5";
const LS_ACTIVE = "nes_active_campaign_v5";
const LS_WORKER_URL = "nes_worker_url_v1";

const el = (id) => document.getElementById(id);

// ---------- UI ----------
const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  libraryCard: el("libraryCard"),
  settingsCard: el("settingsCard"),

  campaignPill: el("campaignPill"),

  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
  ttsMode: el("ttsMode"),
  seed: el("seed"),
  workerSummary: el("workerSummary"),
  openSettingsBtn: el("openSettingsBtn"),

  workerUrl: el("workerUrl"),
  saveWorkerBtn: el("saveWorkerBtn"),
  clearWorkerBtn: el("clearWorkerBtn"),
  workerStatus: el("workerStatus"),
  settingsBtn: el("settingsBtn"),
  closeSettingsBtn: el("closeSettingsBtn"),

  libraryBtn: el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  pauseBtn: el("pauseBtn"),
  stopBtn: el("stopBtn"),

  libraryList: el("libraryList"),
  closeLibraryBtn: el("closeLibraryBtn"),
  newFromLibraryBtn: el("newFromLibraryBtn"),
  wipeBtn: el("wipeBtn"),
  loadBtn: el("loadBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),
  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"),

  startBtn: el("startBtn"),
};

// ---------- Storage ----------
function loadAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAll(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
function setActive(id) { localStorage.setItem(LS_ACTIVE, id); }
function getActiveId() { return localStorage.getItem(LS_ACTIVE); }
function findCampaign(id) { return loadAll().find(c => c.id === id) || null; }
function upsertCampaign(c) {
  const list = loadAll();
  const idx = list.findIndex(x => x.id === c.id);
  if (idx >= 0) list[idx] = c; else list.unshift(c);
  saveAll(list);
}
function deleteCampaign(id) {
  const list = loadAll().filter(c => c.id !== id);
  saveAll(list);
  if (getActiveId() === id) localStorage.removeItem(LS_ACTIVE);
}
function uuid() { return crypto.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2); }

// ---------- Screen helpers ----------
function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }

function hideAllScreens() {
  UI.setupCard && (UI.setupCard.style.display = "none");
  UI.playCard && (UI.playCard.style.display = "none");
  UI.libraryCard && (UI.libraryCard.style.display = "none");
  UI.settingsCard && (UI.settingsCard.style.display = "none");
}
function showSetup() {
  hideAllScreens();
  UI.setupCard && (UI.setupCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = "No campaign");
  refreshWorkerSummary();
}
function showPlay(c) {
  hideAllScreens();
  UI.playCard && (UI.playCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = c.name || "Untitled");
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
}
function showLibrary() {
  hideAllScreens();
  UI.libraryCard && (UI.libraryCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = "Library");
  renderLibrary();
}
function showSettings() {
  hideAllScreens();
  UI.settingsCard && (UI.settingsCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = "Settings");

  const saved = getWorkerUrl() || "";
  if (UI.workerUrl) UI.workerUrl.value = saved;
  if (UI.workerStatus) UI.workerStatus.textContent = saved ? "Worker is saved." : "No worker saved yet.";
}

function setBusy(busy) {
  if (UI.startBtn) UI.startBtn.disabled = busy;
  if (UI.continueBtn) UI.continueBtn.disabled = busy;
  if (UI.wildBtn) UI.wildBtn.disabled = busy;
  const btns = UI.choices?.querySelectorAll?.("button.choiceBtn") || [];
  btns.forEach(b => b.disabled = busy);
}

// ---------- Worker URL persistence ----------
function getWorkerUrl() {
  try { return (localStorage.getItem(LS_WORKER_URL) || "").trim(); }
  catch { return ""; }
}
function setWorkerUrl(v) {
  try { localStorage.setItem(LS_WORKER_URL, (v || "").trim()); } catch {}
  refreshWorkerSummary();
}
function clearWorkerUrl() {
  try { localStorage.removeItem(LS_WORKER_URL); } catch {}
  refreshWorkerSummary();
}
function refreshWorkerSummary() {
  const v = getWorkerUrl();
  if (UI.workerSummary) UI.workerSummary.textContent = v ? "Worker set" : "Not set";
}

// ---------- Speech (iOS-safe + better controls) ----------
let speechUnlocked = false;
let selectedVoice = null;
let speakToken = 0;
let currentUtterance = null;
let pausedByUser = false;

function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}

function loadVoices() {
  if (!speechSupported()) return;
  const voices = speechSynthesis.getVoices();
  if (!voices || !voices.length) return;

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  selectedVoice =
    // best guesses first:
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    voices[0] ||
    null;
}

function unlockSpeechOnce() {
  if (speechUnlocked) return;
  if (!speechSupported()) return;

  // Must be called from a user gesture at least once in iOS/PWA
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  try { speechSynthesis.speak(u); speechSynthesis.cancel(); } catch {}

  speechUnlocked = true;

  loadVoices();
  // voices often arrive late in iOS
  setTimeout(loadVoices, 200);
  setTimeout(loadVoices, 700);
  setTimeout(loadVoices, 1500);
}

if (speechSupported()) {
  speechSynthesis.onvoiceschanged = () => loadVoices();
}

function hardStopSpeech() {
  if (!speechSupported()) return;
  // bump token so any delayed speak is invalidated
  speakToken++;
  pausedByUser = false;
  currentUtterance = null;
  try { speechSynthesis.cancel(); } catch {}
  setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 0);
}

function speakTextIfEnabled(c, text) {
  if (!c?.ttsOn) return;
  if (!speechSupported()) return;
  if (!speechUnlocked) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  // ensure voices are loaded; if not, try again after a beat
  if (!selectedVoice) {
    loadVoices();
    if (!selectedVoice) {
      setTimeout(() => { loadVoices(); }, 150);
    }
  }

  const myToken = ++speakToken;
  pausedByUser = false;

  // stop anything currently speaking
  try { speechSynthesis.cancel(); } catch {}
  setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 0);

  // iOS quirk: needs a tiny delay or it may replay old buffer
  setTimeout(() => {
    if (myToken !== speakToken) return;

    // final cancel before speak
    try { speechSynthesis.cancel(); } catch {}

    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;

    if (selectedVoice) u.voice = selectedVoice;

    currentUtterance = u;

    try { speechSynthesis.speak(u); } catch {}
  }, 90);
}

function togglePauseResume() {
  unlockSpeechOnce();
  if (!speechSupported()) return;

  try {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
      pausedByUser = true;
      return;
    }
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
      pausedByUser = false;
      return;
    }
    // If iOS says "not speaking" but we have text, replay it:
    const c = findCampaign(getActiveId());
    if (c && c.story) speakTextIfEnabled(c, c.story);
  } catch {}
}

// Unlock on first tap anywhere (helps iOS)
window.addEventListener("pointerdown", () => unlockSpeechOnce(), { once: true });

// ---------- Worker call + parsing ----------
async function callWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); }
  catch { throw new Error("Worker returned non-JSON. Raw:\n" + txt.slice(0, 400)); }

  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  if (json?.error && !json.story_text && !json.text) throw new Error(String(json.error));
  return json;
}

function normalizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3);
}

function parseWorkerResponse(json) {
  if (!json || typeof json !== "object") return { storyText: "", choices: [], memoryCapsule: "" };

  if (json.story_text || json.memory_capsule || Array.isArray(json.choices)) {
    return {
      storyText: String(json.story_text || "").trim(),
      choices: normalizeChoices(json.choices),
      memoryCapsule: String(json.memory_capsule || "").trim(),
    };
  }

  const raw = String(json.text || json.output_text || json.raw || "").trim();
  const storyMatch = raw.match(/\[STORY\]([\s\S]*?)(?=\[CHOICES\]|\[MEMORY\]|$)/i);
  const choicesMatch = raw.match(/\[CHOICES\]([\s\S]*?)(?=\[MEMORY\]|$)/i);
  const memoryMatch = raw.match(/\[MEMORY\]([\s\S]*?)$/i);

  const story = String(storyMatch?.[1] || "").trim();
  const choicesBlock = String(choicesMatch?.[1] || "").trim();
  const memory = String(memoryMatch?.[1] || "").trim();

  const choices = [];
  if (choicesBlock) {
    const lines = choicesBlock.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^([1-3])[\)\.\-:]\s+(.*)$/);
      if (m) choices[parseInt(m[1], 10) - 1] = m[2].trim();
    }
  }
  return { storyText: story, choices: choices.filter(Boolean).slice(0, 3), memoryCapsule: memory };
}

// ---------- Rendering ----------
function renderStory(c, text) {
  const clean = String(text || "").trim();
  if (UI.storyText) UI.storyText.textContent = clean;
  speakTextIfEnabled(c, clean);
}
function renderChoices(c, list) {
  if (!UI.choices) return;
  UI.choices.innerHTML = "";

  const choices = normalizeChoices(list);
  if (!choices.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices detected. Use “Something else” or Continue.";
    UI.choices.appendChild(d);
    return;
  }

  choices.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${idx + 1}) ${label}`;
    btn.onclick = () => advance(c, idx + 1, label);
    UI.choices.appendChild(btn);
  });
}

// ---------- Memory builders ----------
function buildStartMemory(seed, rating, pacing) {
  return [
    "[Story Seed]",
    seed,
    "",
    "[Settings]",
    `rating=${rating}`,
    `pacing=${pacing}`,
    "",
    "Instruction: Write in English. Return EXACT tags:",
    "[STORY] ...",
    "[CHOICES] 1..3",
    "[MEMORY] ...",
  ].join("\n");
}
function buildNextMemory(c, actionText) {
  const cap = c.memoryCapsule || "";
  return [
    cap ? "[MEMORY]\n" + cap : "[MEMORY]\n",
    "",
    "[PLAYER_ACTION]",
    actionText,
  ].join("\n");
}

// ---------- Actions ----------
async function startNew() {
  unlockSpeechOnce();

  const workerUrl = getWorkerUrl();
  if (!workerUrl) { alert("Set your Worker URL in Settings first."); showSettings(); return; }

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();
  const ttsOn = ((UI.ttsMode?.value || "off") === "on");

  const c = { id: uuid(), name, workerUrl, rating, pacing, ttsOn, story:"", choices:[], memoryCapsule:"", segments:[] };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  setBusy(true);
  setStatus("Starting...");
  try {
    hardStopSpeech();

    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callWorker(workerUrl, { action: "Begin the story.", memory });
    const parsed = parseWorkerResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    renderStory(c, c.story);
    renderChoices(c, c.choices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;

    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
    showSetup();
  } finally {
    setBusy(false);
  }
}

async function advance(c, choiceNumber, actionText) {
  unlockSpeechOnce();

  setBusy(true);
  setStatus("Generating...");
  try {
    hardStopSpeech();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseWorkerResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";
    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });

    upsertCampaign(c);

    renderStory(c, c.story);
    renderChoices(c, c.choices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;

    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

function replay() {
  unlockSpeechOnce();
  const c = findCampaign(getActiveId());
  if (!c) return;
  // IMPORTANT: do NOT re-render the DOM; just speak the latest story text
  speakTextIfEnabled(c, c.story || "");
}

function undo() {
  unlockSpeechOnce();
  const c = findCampaign(getActiveId());
  if (!c) return;

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.story = last?.story || "";
  c.choices = last?.choices || [];

  upsertCampaign(c);
  renderStory(c, c.story);
  renderChoices(c, c.choices);
  setStatus("Undid last step.");
}

function continueStory() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  advance(c, 0, "Continue.");
}
function doWildcard() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  const t = (UI.wildInput?.value || "").trim();
  if (!t) return alert("Type your action first.");
  UI.wildInput.value = "";
  advance(c, 0, t);
}

// ---------- Library ----------
function renderLibrary() {
  if (!UI.libraryList) return;
  const list = loadAll();
  UI.libraryList.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No campaigns yet. Tap “New Story”.";
    UI.libraryList.appendChild(empty);
    return;
  }

  list.forEach((c) => {
    const item = document.createElement("div");
    item.className = "listItem";

    const title = document.createElement("div");
    title.className = "listTitle";
    title.textContent = c.name || "Untitled";

    const meta = document.createElement("div");
    meta.className = "muted";
    const date = c.segments?.length ? new Date(c.segments[c.segments.length - 1].at).toLocaleString() : "—";
    meta.textContent = `Segments: ${c.segments?.length || 0} • Last: ${date}`;

    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "10px";

    const openBtn = document.createElement("button");
    openBtn.textContent = "Open";
    openBtn.onclick = () => {
      setActive(c.id);
      const fresh = findCampaign(c.id);
      if (!fresh) return;
      showPlay(fresh);
      renderStory(fresh, fresh.story || "");
      renderChoices(fresh, fresh.choices || []);
      if (UI.memoryBox) UI.memoryBox.textContent = fresh.memoryCapsule || "";
      setStatus("Loaded.");
    };

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (!confirm(`Delete "${c.name}" from this device?`)) return;
      deleteCampaign(c.id);
      renderLibrary();
    };

    row.appendChild(openBtn);
    row.appendChild(delBtn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(row);

    UI.libraryList.appendChild(item);
  });
}

function wipeAll() {
  if (!confirm("Delete ALL campaigns stored on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local campaigns wiped.");
  renderLibrary();
}

// ---------- Boot ----------
function boot() {
  refreshWorkerSummary();

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c, c.story || "");
    renderChoices(c, c.choices || []);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  UI.startBtn && (UI.startBtn.onclick = startNew);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => { hardStopSpeech(); showLibrary(); });
  UI.loadBtn && (UI.loadBtn.onclick = () => showLibrary());

  UI.closeLibraryBtn && (UI.closeLibraryBtn.onclick = () => showSetup());
  UI.newFromLibraryBtn && (UI.newFromLibraryBtn.onclick = () => showSetup());
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeAll);

  UI.settingsBtn && (UI.settingsBtn.onclick = () => showSettings());
  UI.openSettingsBtn && (UI.openSettingsBtn.onclick = () => showSettings());
  UI.closeSettingsBtn && (UI.closeSettingsBtn.onclick = () => showSetup());

  UI.saveWorkerBtn && (UI.saveWorkerBtn.onclick = () => {
    const v = (UI.workerUrl?.value || "").trim();
    if (!v) return alert("Paste your Worker URL first.");
    setWorkerUrl(v);
    if (UI.workerStatus) UI.workerStatus.textContent = "Saved.";
  });

  UI.clearWorkerBtn && (UI.clearWorkerBtn.onclick = () => {
    clearWorkerUrl();
    if (UI.workerUrl) UI.workerUrl.value = "";
    if (UI.workerStatus) UI.workerStatus.textContent = "Cleared.";
  });

  UI.replayBtn && (UI.replayBtn.onclick = () => replay());
  UI.undoBtn && (UI.undoBtn.onclick = () => undo());

  UI.pauseBtn && (UI.pauseBtn.onclick = () => togglePauseResume());
  UI.stopBtn && (UI.stopBtn.onclick = () => hardStopSpeech());

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // iOS voice list loads late
  if (speechSupported()) setTimeout(() => { try { speechSynthesis.getVoices(); loadVoices(); } catch {} }, 400);
}

boot();
