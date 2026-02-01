/* Neverending Story PWA – Clean app.js (iOS-safe speech + pause/stop)
   - Worker expects JSON: { story_text, choices[], memory_capsule }
     (also supports { text: "...tagged..." } fallback)
   - Robust iOS speech: prevents "repeats chapter 1" bug using a speak token + delay
   - Pause/Stop supported if buttons exist in HTML: #pauseBtn, #stopBtn
*/

const LS_KEY = "nes_campaigns_v4";
const LS_ACTIVE = "nes_active_campaign_v4";

const el = (id) => document.getElementById(id);

// ---------- UI ----------
const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
  ttsMode: el("ttsMode"),
  seed: el("seed"),

  startBtn: el("startBtn"),
  loadBtn: el("loadBtn"),
  wipeBtn: el("wipeBtn"),

  libraryBtn: el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  pauseBtn: el("pauseBtn"), // optional
  stopBtn: el("stopBtn"),   // optional

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),

  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"), // debug panel only
};

// ---------- Storage ----------
function loadAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAll(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
function setActive(id) {
  localStorage.setItem(LS_ACTIVE, id);
}
function getActiveId() {
  return localStorage.getItem(LS_ACTIVE);
}
function findCampaign(id) {
  return loadAll().find(c => c.id === id) || null;
}
function upsertCampaign(c) {
  const list = loadAll();
  const idx = list.findIndex(x => x.id === c.id);
  if (idx >= 0) list[idx] = c;
  else list.unshift(c);
  saveAll(list);
}
function uuid() {
  // iOS 16+ supports crypto.randomUUID; keep fallback anyway
  return (crypto.randomUUID?.() ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      const v = (ch === "x") ? r : (r & 3) | 8;
      return v.toString(16);
    })
  );
}

// ---------- UI helpers ----------
function setStatus(msg) {
  if (UI.statusLine) UI.statusLine.textContent = msg;
}
function showSetup() {
  if (UI.setupCard) UI.setupCard.style.display = "";
  if (UI.playCard) UI.playCard.style.display = "none";
  if (UI.campaignPill) UI.campaignPill.textContent = "No campaign";
}
function showPlay(c) {
  if (UI.setupCard) UI.setupCard.style.display = "none";
  if (UI.playCard) UI.playCard.style.display = "";
  if (UI.campaignPill) UI.campaignPill.textContent = c.name || "Untitled";
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
}
function setBusy(busy) {
  if (UI.startBtn) UI.startBtn.disabled = busy;
  if (UI.loadBtn) UI.loadBtn.disabled = busy;
  if (UI.wipeBtn) UI.wipeBtn.disabled = busy;
  if (UI.continueBtn) UI.continueBtn.disabled = busy;
  if (UI.wildBtn) UI.wildBtn.disabled = busy;
  const btns = UI.choices?.querySelectorAll?.("button.choiceBtn") || [];
  btns.forEach(btn => btn.disabled = busy);
}

// ---------- Speech (iOS-safe) ----------
let speechUnlocked = false;
let selectedVoice = null;
let speakToken = 0;

function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}

function loadVoices() {
  if (!speechSupported()) return;
  const voices = speechSynthesis.getVoices();
  if (!voices || !voices.length) return;

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  selectedVoice =
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    voices[0] ||
    null;
}

function unlockSpeechOnce() {
  if (speechUnlocked) return;
  if (!speechSupported()) return;

  // iOS unlock: speak a silent utterance on user gesture
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  try {
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch { /* ignore */ }

  speechUnlocked = true;

  // iOS voice list loads late; do a couple attempts
  loadVoices();
  setTimeout(loadVoices, 250);
  setTimeout(loadVoices, 750);
}

if (speechSupported()) {
  speechSynthesis.onvoiceschanged = () => loadVoices();
}

// HARD stop helper (iOS sometimes needs double-cancel)
function hardStopSpeech() {
  if (!speechSupported()) return;
  try { speechSynthesis.cancel(); } catch {}
  // second cancel in next tick helps on iOS
  setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 0);
}

function speakTextIfEnabled(c, text) {
  if (!c?.ttsOn) return;
  if (!speechSupported()) return;
  if (!speechUnlocked) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  // invalidate any pending speak calls
  const myToken = ++speakToken;

  // stop anything currently speaking
  hardStopSpeech();

  // Delay is critical on iOS to prevent old buffer replay
  setTimeout(() => {
    if (myToken !== speakToken) return; // a newer speak was requested

    // stop again right before speaking (iOS quirk)
    hardStopSpeech();

    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    if (selectedVoice) u.voice = selectedVoice;

    try { speechSynthesis.speak(u); } catch { /* ignore */ }
  }, 80);
}

function pauseSpeech() {
  if (!speechSupported()) return;
  try {
    if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause();
  } catch {}
}
function resumeSpeech() {
  if (!speechSupported()) return;
  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
  } catch {}
}
function stopSpeech() {
  hardStopSpeech();
}

// Unlock speech on first user gesture anywhere (best for iOS)
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

// Supports either structured JSON or tagged text blob
function parseWorkerResponse(json) {
  if (!json || typeof json !== "object") {
    return { storyText: "", choices: [], memoryCapsule: "" };
  }

  // Structured
  if (json.story_text || json.memory_capsule || Array.isArray(json.choices)) {
    return {
      storyText: String(json.story_text || "").trim(),
      choices: normalizeChoices(json.choices),
      memoryCapsule: String(json.memory_capsule || "").trim(),
    };
  }

  // Tagged blob fallback: { text: "...[STORY]..[CHOICES]..[MEMORY].." }
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

// ---------- Main actions ----------
async function startNew() {
  unlockSpeechOnce();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();
  const ttsOn = ((UI.ttsMode?.value || "off") === "on");

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating,
    pacing,
    ttsOn,
    story: "",
    choices: [],
    memoryCapsule: "",
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  setBusy(true);
  setStatus("Starting...");
  try {
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
  } finally {
    setBusy(false);
  }
}

async function advance(c, choiceNumber, actionText) {
  unlockSpeechOnce();

  setBusy(true);
  setStatus("Generating...");
  try {
    // stop any current speech before generating next
    stopSpeech();

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
  renderStory(c, c.story);
}

function undo() {
  unlockSpeechOnce();
  const c = findCampaign(getActiveId());
  if (!c) return;

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return; // keep first segment

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.story = last?.story || "";
  c.choices = last?.choices || [];

  upsertCampaign(c);
  renderStory(c, c.story);
  renderChoices(c, c.choices);
  setStatus("Undid last step.");
}

function loadExisting() {
  const list = loadAll();
  if (!list.length) return alert("No saved campaigns on this device.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);

  renderStory(c, c.story || "");
  renderChoices(c, c.choices || []);
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("Delete ALL campaigns stored on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  showSetup();
  alert("Local campaigns wiped.");
}

// Continue / wildcard
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

// ---------- Boot ----------
function boot() {
  // Restore last worker URL (best effort)
  const last = loadAll()[0];
  if (last?.workerUrl && UI.workerUrl) UI.workerUrl.value = last.workerUrl;

  // Restore active campaign if any
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

  // Wire buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeAll);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => {
    stopSpeech();
    showSetup();
    setStatus("Ready.");
  });

  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  // Optional pause/stop buttons
  UI.pauseBtn && (UI.pauseBtn.onclick = () => {
    unlockSpeechOnce();
    // toggle pause/resume
    try {
      if (speechSynthesis.paused) resumeSpeech();
      else pauseSpeech();
    } catch {}
  });

  UI.stopBtn && (UI.stopBtn.onclick = () => {
    unlockSpeechOnce();
    stopSpeech();
  });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Kick voices list (iOS loads late)
  if (speechSupported()) {
    setTimeout(() => { try { speechSynthesis.getVoices(); } catch {} }, 300);
  }
}

boot();
