/* Neverending Story – app.js (Story worker + optional AI TTS worker)
   - Saves Story Worker URL + TTS Worker URL so you don’t retype each time
   - Narration modes: Off / Local (Apple speechSynthesis) / AI (OpenAI TTS worker)
   - iOS-safe audio: plays from user gestures, cancels stale playback, no “chapter 1 repeat”
*/

const LS_KEY = "nes_campaigns_v5";
const LS_ACTIVE = "nes_active_campaign_v5";
const LS_SETTINGS = "nes_settings_v5";

const el = (id) => document.getElementById(id);

// ---------- UI ----------
const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  ttsWorkerUrl: el("ttsWorkerUrl"),
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
  pauseBtn: el("pauseBtn"),
  stopBtn: el("stopBtn"),
  undoBtn: el("undoBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),

  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"),
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
  if (idx >= 0) list[idx] = c; else list.unshift(c);
  saveAll(list);
}
function uuid() {
  return (crypto.randomUUID?.() ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      const v = (ch === "x") ? r : (r & 3) | 8;
      return v.toString(16);
    })
  );
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}"); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s || {}));
}

// ---------- UI helpers ----------
function setStatus(msg) {
  if (UI.statusLine) UI.statusLine.textContent = msg;
}
function showSetup() {
  UI.setupCard.style.display = "";
  UI.playCard.style.display = "none";
  UI.campaignPill.textContent = "No campaign";
}
function showPlay(c) {
  UI.setupCard.style.display = "none";
  UI.playCard.style.display = "";
  UI.campaignPill.textContent = c.name || "Untitled";
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
}
function setBusy(busy) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(b => { if (b) b.disabled = busy; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(b => b.disabled = busy);
}

// ---------- Click sound ----------
let clickAudio = null;
function playClick() {
  try {
    clickAudio = clickAudio || new Audio("click.mp3");
    clickAudio.currentTime = 0;
    clickAudio.play().catch(() => {});
  } catch {}
}

// ---------- Narration engine ----------
let audioEl = null;
let lastNarratedText = "";
let narrationToken = 0;

// Local (Apple) speechSynthesis
let localSpeechUnlocked = false;
let localVoice = null;

function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}

function loadLocalVoices() {
  if (!speechSupported()) return;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return;

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  localVoice =
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    voices[0] ||
    null;
}

if (speechSupported()) {
  speechSynthesis.onvoiceschanged = () => loadLocalVoices();
}

function unlockLocalSpeechOnce() {
  if (localSpeechUnlocked) return;
  if (!speechSupported()) return;

  // iOS unlock: must be inside user gesture at least once
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  try {
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch {}

  localSpeechUnlocked = true;
  loadLocalVoices();
  setTimeout(loadLocalVoices, 250);
  setTimeout(loadLocalVoices, 750);
}

function stopLocalSpeech() {
  if (!speechSupported()) return;
  try { speechSynthesis.cancel(); } catch {}
  setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 0);
}

function speakLocal(text) {
  if (!speechSupported()) return;
  if (!localSpeechUnlocked) return;

  stopLocalSpeech();

  const u = new SpeechSynthesisUtterance(String(text || ""));
  u.lang = "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  if (localVoice) u.voice = localVoice;

  // small delay helps iOS avoid replaying old utterances
  setTimeout(() => {
    try { speechSynthesis.speak(u); } catch {}
  }, 80);
}

// AI TTS audio element
function ensureAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "auto";
  }
  return audioEl;
}

function stopAudio() {
  const a = audioEl;
  if (!a) return;
  try {
    a.pause();
    a.currentTime = 0;
  } catch {}
}

function pauseOrResumeAudio() {
  const mode = UI.ttsMode?.value || "off";

  if (mode === "local") {
    if (!speechSupported()) return;
    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      else speechSynthesis.pause();
    } catch {}
    return;
  }

  if (mode === "ai") {
    const a = audioEl;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }
}

function stopNarration() {
  stopAudio();
  stopLocalSpeech();
}

async function narrateViaTTSWorker(ttsUrl, text) {
  const clean = String(text || "").trim();
  if (!clean) return;

  const myToken = ++narrationToken;

  // Always stop any previous audio before starting a new one
  stopAudio();

  // If we’re re-narrating the same text, allow replay (don’t return early)
  lastNarratedText = clean;

  // Fetch audio
  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ text: clean }),
  });

  const json = await res.json().catch(() => ({}));
  if (myToken !== narrationToken) return; // a newer narration replaced this one

  if (!res.ok) {
    throw new Error(json?.error || `TTS HTTP ${res.status}`);
  }
  if (!json.audio_base64) {
    throw new Error("TTS worker returned no audio_base64");
  }

  const a = ensureAudioEl();
  a.src = "data:audio/mpeg;base64," + json.audio_base64;

  // Must be called from user gesture chain to autoplay on iOS
  await a.play();
}

async function narrateIfEnabled(c, storyText, reason = "") {
  if (!c) return;
  const mode = UI.ttsMode?.value || "off";
  const clean = String(storyText || "").trim();
  if (!clean) return;

  // Save UI selection as preference
  persistSettingsFromUI();

  if (mode === "off") return;

  // Always stop whatever was playing before narrating new story
  stopNarration();

  // Local mode
  if (mode === "local") {
    unlockLocalSpeechOnce();
    speakLocal(clean);
    return;
  }

  // AI mode
  if (mode === "ai") {
    const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
    if (!ttsUrl) {
      setStatus("Ready (no TTS URL)");
      return;
    }
    setStatus(reason ? `Narrating (${reason})...` : "Narrating...");
    await narrateViaTTSWorker(ttsUrl, clean);
    setStatus("Ready.");
  }
}

// Unlock local speech on first user gesture (helps iOS)
window.addEventListener("pointerdown", () => unlockLocalSpeechOnce(), { once: true });

// ---------- Worker call + parsing ----------
async function callStoryWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); }
  catch { throw new Error("Story worker returned non-JSON:\n" + txt.slice(0, 400)); }

  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  if (json?.error && !json.story_text) throw new Error(String(json.error));

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
function renderStory(text) {
  UI.storyText.textContent = String(text || "").trim();
}
function renderChoices(c, list) {
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
    btn.onclick = async () => {
      playClick();
      // User gesture chain continues here → good for iOS audio
      const active = findCampaign(getActiveId());
      if (active) await advance(active, idx + 1, label);
    };
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

// ---------- Settings persistence ----------
function persistSettingsFromUI() {
  const s = loadSettings();
  s.workerUrl = (UI.workerUrl?.value || "").trim();
  s.ttsWorkerUrl = (UI.ttsWorkerUrl?.value || "").trim();
  s.ttsMode = UI.ttsMode?.value || "off";
  s.rating = UI.rating?.value || "PG-13";
  s.pacing = UI.pacing?.value || "long";
  saveSettings(s);
}
function applySettingsToUI() {
  const s = loadSettings();
  if (s.workerUrl && UI.workerUrl) UI.workerUrl.value = s.workerUrl;
  if (s.ttsWorkerUrl && UI.ttsWorkerUrl) UI.ttsWorkerUrl.value = s.ttsWorkerUrl;
  if (s.ttsMode && UI.ttsMode) UI.ttsMode.value = s.ttsMode;
  if (s.rating && UI.rating) UI.rating.value = s.rating;
  if (s.pacing && UI.pacing) UI.pacing.value = s.pacing;

  // Default TTS worker if empty
  if (UI.ttsWorkerUrl && !UI.ttsWorkerUrl.value.trim()) {
    UI.ttsWorkerUrl.value = "https://nes-tts.292q4hbvh4.workers.dev/";
  }
}

// ---------- Main actions ----------
async function startNew() {
  playClick();
  unlockLocalSpeechOnce(); // harmless if using AI; helps iOS if switching

  persistSettingsFromUI();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating,
    pacing,
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
    const json = await callStoryWorker(workerUrl, { action: "Begin the story.", memory });
    const parsed = parseWorkerResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    renderStory(c.story);
    renderChoices(c, c.choices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;

    // Narrate the NEW story (from this start tap)
    await narrateIfEnabled(c, c.story, "start");

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
  persistSettingsFromUI();

  setBusy(true);
  setStatus("Generating...");
  try {
    // stop old narration before new request
    stopNarration();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseWorkerResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";

    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });

    upsertCampaign(c);

    renderStory(c.story);
    renderChoices(c, c.choices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;

    // Narrate the NEW story (from this choice tap)
    await narrateIfEnabled(c, c.story, "choice");

    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

async function replay() {
  playClick();
  const c = findCampaign(getActiveId());
  if (!c) return;
  await narrateIfEnabled(c, c.story, "replay");
}

function undo() {
  playClick();
  const c = findCampaign(getActiveId());
  if (!c) return;

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.story = last?.story || "";
  c.choices = last?.choices || [];

  upsertCampaign(c);

  renderStory(c.story);
  renderChoices(c, c.choices);
  setStatus("Undid last step.");
}

function loadExisting() {
  playClick();
  const list = loadAll();
  if (!list.length) return alert("No saved campaigns on this device.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);

  renderStory(c.story || "");
  renderChoices(c, c.choices || []);
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
  setStatus("Loaded.");
}

function wipeAll() {
  playClick();
  if (!confirm("Delete ALL campaigns stored on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  showSetup();
  alert("Local campaigns wiped.");
}

// Continue / wildcard
async function continueStory() {
  playClick();
  const c = findCampaign(getActiveId());
  if (!c) return;
  await advance(c, 0, "Continue.");
}
async function doWildcard() {
  playClick();
  const c = findCampaign(getActiveId());
  if (!c) return;
  const t = (UI.wildInput?.value || "").trim();
  if (!t) return alert("Type your action first.");
  UI.wildInput.value = "";
  await advance(c, 0, t);
}

// ---------- Boot ----------
function boot() {
  applySettingsToUI();

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c.story || "");
    renderChoices(c, c.choices || []);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // Wire buttons
  UI.startBtn.onclick = startNew;
  UI.loadBtn.onclick = loadExisting;
  UI.wipeBtn.onclick = wipeAll;

  UI.libraryBtn.onclick = () => {
    playClick();
    stopNarration();
    showSetup();
    setStatus("Ready.");
  };

  UI.replayBtn.onclick = replay;
  UI.undoBtn.onclick = undo;

  UI.pauseBtn.onclick = () => {
    playClick();
    pauseOrResumeAudio();
  };

  UI.stopBtn.onclick = () => {
    playClick();
    stopNarration();
    setStatus("Ready.");
  };

  UI.continueBtn.onclick = continueStory;
  UI.wildBtn.onclick = doWildcard;

  // Persist settings when changed
  [UI.workerUrl, UI.ttsWorkerUrl, UI.ttsMode, UI.rating, UI.pacing].forEach(ctrl => {
    if (!ctrl) return;
    ctrl.addEventListener("change", persistSettingsFromUI);
    ctrl.addEventListener("blur", persistSettingsFromUI);
  });

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Kick local voice list
  if (speechSupported()) {
    setTimeout(() => { try { speechSynthesis.getVoices(); } catch {} }, 300);
  }
}

boot();
