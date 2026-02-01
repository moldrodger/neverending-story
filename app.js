/* Neverending Story – app.js (stable, iPhone-safe)
   - 3 narration modes: off | local(speechSynthesis) | openai(worker WebAudio)
   - Saves URLs/voice/mode so you don't retype
   - Replay/Pause/Stop work
   - Wipe menu: all library | current story | last chapter
*/

const LS_KEY = "nes_campaigns_v6";
const LS_ACTIVE = "nes_active_campaign_v6";

const LS_STORY_URL = "nes_story_worker_url";
const LS_TTS_URL   = "nes_tts_worker_url";
const LS_TTS_VOICE = "nes_tts_voice";
const LS_NARR_MODE = "nes_narr_mode";
const LS_LOCAL_VOICE = "nes_local_voice";

const el = (id) => document.getElementById(id);

const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  ttsWorkerUrl: el("ttsWorkerUrl"),

  narrationMode: el("narrationMode"),
  localVoice: el("localVoice"),
  ttsVoice: el("ttsVoice"),

  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
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

// ---------- storage ----------
function loadAll() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; } }
function saveAll(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
function setActive(id) { localStorage.setItem(LS_ACTIVE, id); }
function getActiveId() { return localStorage.getItem(LS_ACTIVE); }
function findCampaign(id) { return loadAll().find(c => c.id === id) || null; }
function upsertCampaign(c) {
  const list = loadAll();
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c; else list.unshift(c);
  saveAll(list);
}
function removeCampaign(id) {
  const list = loadAll().filter(c => c.id !== id);
  saveAll(list);
  if (getActiveId() === id) localStorage.removeItem(LS_ACTIVE);
}
function uuid() { return crypto.randomUUID(); }

// ---------- ui ----------
function setStatus(msg) { UI.statusLine && (UI.statusLine.textContent = msg); }
function showSetup() {
  UI.setupCard && (UI.setupCard.style.display = "");
  UI.playCard && (UI.playCard.style.display = "none");
  UI.campaignPill && (UI.campaignPill.textContent = "No campaign");
}
function showPlay(c) {
  UI.setupCard && (UI.setupCard.style.display = "none");
  UI.playCard && (UI.playCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = c.name || "Untitled");
  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
}
function setBusy(b) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(x => { if (x) x.disabled = b; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(btn => btn.disabled = b);
}

// ---------- story worker ----------
async function callStoryWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error("Story worker returned non-JSON."); }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  if (json?.error && !json.story_text && !json.text) throw new Error(String(json.error));
  return json;
}

function normalizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3);
}

function parseStoryResponse(json) {
  if (!json || typeof json !== "object") return { storyText: "", choices: [], memoryCapsule: "" };

  if (json.story_text || json.memory_capsule || Array.isArray(json.choices)) {
    return {
      storyText: String(json.story_text || "").trim(),
      choices: normalizeChoices(json.choices),
      memoryCapsule: String(json.memory_capsule || "").trim(),
    };
  }

  const raw = String(json.text || json.output_text || json.raw || "");
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

function buildStartMemory(seed, rating, pacing) {
  return [
    "[Story Seed]",
    seed,
    "",
    "[Settings]",
    `rating=${rating}`,
    `pacing=${pacing}`,
    "",
    "Instruction: Return EXACT tags:",
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

// ---------- narration: mode switch ----------
function getNarrationMode() {
  return (UI.narrationMode?.value || "off");
}

// ---------- narration: local speechSynthesis ----------
let localUnlocked = false;
let localVoiceObj = null;

function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}

function unlockLocalSpeechOnce() {
  if (localUnlocked) return;
  if (!speechSupported()) return;

  // iOS: must be from a user gesture — we call this from button handlers too
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
    localUnlocked = true;
  } catch {}
}

function loadLocalVoicesIntoDropdown() {
  if (!speechSupported() || !UI.localVoice) return;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return;

  const current = UI.localVoice.value || "auto";
  const opts = [];

  opts.push({ value: "auto", label: "Auto (best English)" });

  voices
    .filter(v => (v.lang || "").toLowerCase().startsWith("en"))
    .sort((a,b) => (a.lang || "").localeCompare(b.lang || "") || (a.name || "").localeCompare(b.name || ""))
    .forEach(v => {
      const val = `${v.name}|||${v.lang}`;
      opts.push({ value: val, label: `${v.name} (${v.lang})` });
    });

  UI.localVoice.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    UI.localVoice.appendChild(opt);
  }

  // restore selection if possible
  UI.localVoice.value = opts.some(o => o.value === current) ? current : "auto";
  pickLocalVoiceObj();
}

function pickLocalVoiceObj() {
  localVoiceObj = null;
  if (!speechSupported()) return;

  const voices = speechSynthesis.getVoices() || [];
  const pick = UI.localVoice?.value || "auto";
  localStorage.setItem(LS_LOCAL_VOICE, pick);

  if (pick === "auto") {
    const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
    localVoiceObj =
      en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
      en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
      en[0] ||
      voices[0] ||
      null;
    return;
  }

  const [name, lang] = pick.split("|||");
  localVoiceObj = voices.find(v => v.name === name && v.lang === lang) || null;
}

function stopLocalSpeech() {
  if (!speechSupported()) return;
  try { speechSynthesis.cancel(); } catch {}
}
function pauseLocalSpeech() {
  if (!speechSupported()) return;
  try { if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause(); } catch {}
}
function resumeLocalSpeech() {
  if (!speechSupported()) return;
  try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
}

function speakLocal(text) {
  if (!speechSupported()) return;
  if (!localUnlocked) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  stopLocalSpeech();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  if (localVoiceObj) u.voice = localVoiceObj;

  // iOS bug prevention: slight delay
  setTimeout(() => { try { speechSynthesis.speak(u); } catch {} }, 60);
}

// ---------- narration: OpenAI TTS via WebAudio ----------
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let lastBuffer = null;
let audioUnlocked = false;
let narrToken = 0;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

async function unlockAudioOnce() {
  if (audioUnlocked) return;
  const ctx = ensureAudioContext();
  try { if (ctx.state !== "running") await ctx.resume(); } catch {}
  audioUnlocked = true;
}

function stopOpenAiNarration() {
  narrToken++;
  try { if (sourceNode) sourceNode.stop(); } catch {}
  sourceNode = null;
}

async function pauseOpenAiNarration() {
  const ctx = ensureAudioContext();
  try { if (ctx.state === "running") await ctx.suspend(); } catch {}
}

async function resumeOpenAiNarration() {
  const ctx = ensureAudioContext();
  try { if (ctx.state !== "running") await ctx.resume(); } catch {}
}

function base64ToArrayBuffer(base64) {
  const clean = String(base64 || "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function playBuffer(buf) {
  const ctx = ensureAudioContext();
  await unlockAudioOnce();
  await resumeOpenAiNarration();

  stopOpenAiNarration();

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(gainNode);
  sourceNode.start(0);
}

async function fetchAndNarrateOpenAI(text) {
  const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
  if (!ttsUrl) throw new Error("Missing TTS worker URL.");

  const voice = (UI.ttsVoice?.value || "alloy");
  const my = ++narrToken;

  stopOpenAiNarration();
  setStatus("Narrating...");

  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ text, voice }),
  });

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error("TTS worker returned non-JSON."); }
  if (!res.ok) throw new Error(json?.error || `TTS HTTP ${res.status}`);

  if (my !== narrToken) return;

  const b64 = json.audio_base64;
  if (!b64) throw new Error("TTS worker returned no audio_base64.");

  const ctx = ensureAudioContext();
  await unlockAudioOnce();

  const arr = base64ToArrayBuffer(b64);
  const decoded = await new Promise((resolve, reject) => {
    ctx.decodeAudioData(arr.slice(0), resolve, reject);
  });

  if (my !== narrToken) return;

  lastBuffer = decoded;
  await playBuffer(decoded);
  setStatus("Ready.");
}

// ---------- unified narration controls ----------
function stopNarration() {
  stopLocalSpeech();
  stopOpenAiNarration();
}

async function pauseResumeNarrationToggle() {
  const mode = getNarrationMode();
  if (mode === "local") {
    if (!speechSupported()) return;
    if (speechSynthesis.paused) resumeLocalSpeech();
    else pauseLocalSpeech();
    return;
  }
  if (mode === "openai") {
    const ctx = ensureAudioContext();
    if (ctx.state === "running") await pauseOpenAiNarration();
    else await resumeOpenAiNarration();
  }
}

async function narrateIfEnabled(text) {
  const mode = getNarrationMode();
  const clean = String(text || "").trim();
  if (!clean) return;

  if (mode === "off") return;

  if (mode === "local") {
    unlockLocalSpeechOnce();
    pickLocalVoiceObj();
    speakLocal(clean);
    return;
  }

  if (mode === "openai") {
    await unlockAudioOnce();
    await fetchAndNarrateOpenAI(clean);
  }
}

// Unlock audio/speech on first gesture anywhere (helps iOS)
window.addEventListener("pointerdown", () => {
  unlockAudioOnce().catch(() => {});
  unlockLocalSpeechOnce();
}, { once: true });

// ---------- rendering ----------
function renderStory(c, text) {
  const clean = String(text || "").trim();
  UI.storyText && (UI.storyText.textContent = clean);
  // always narrate based on current UI mode
  narrateIfEnabled(clean).catch(e => {
    console.error(e);
    setStatus("Ready (no audio).");
  });
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

// ---------- main actions ----------
async function startNew() {
  await unlockAudioOnce().catch(() => {});
  unlockLocalSpeechOnce();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  // persist settings
  localStorage.setItem(LS_STORY_URL, workerUrl);
  localStorage.setItem(LS_TTS_URL, (UI.ttsWorkerUrl?.value || "").trim());
  localStorage.setItem(LS_TTS_VOICE, (UI.ttsVoice?.value || "alloy"));
  localStorage.setItem(LS_NARR_MODE, (UI.narrationMode?.value || "off"));
  localStorage.setItem(LS_LOCAL_VOICE, (UI.localVoice?.value || "auto"));

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
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices, memoryCapsule: c.memoryCapsule }];

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c, c.story);
    renderChoices(c, c.choices);

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
  await unlockAudioOnce().catch(() => {});
  unlockLocalSpeechOnce();

  setBusy(true);
  setStatus("Generating...");
  try {
    stopNarration();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";

    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices, memoryCapsule: c.memoryCapsule });

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c, c.story);
    renderChoices(c, c.choices);

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
  await unlockAudioOnce().catch(() => {});
  unlockLocalSpeechOnce();

  const c = findCampaign(getActiveId());
  if (!c) return;

  const mode = getNarrationMode();
  if (mode === "openai" && lastBuffer) {
    setStatus("Narrating...");
    playBuffer(lastBuffer)
      .then(() => setStatus("Ready."))
      .catch((e) => { console.error(e); setStatus("Ready (no audio)."); });
    return;
  }

  renderStory(c, c.story || "");
}

function undo() {
  const c = findCampaign(getActiveId());
  if (!c) return;

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.story = last?.story || "";
  c.choices = last?.choices || [];
  c.memoryCapsule = last?.memoryCapsule || c.memoryCapsule || "";

  upsertCampaign(c);

  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
  renderStory(c, c.story);
  renderChoices(c, c.choices);
  setStatus("Undid last chapter.");
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

  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
  renderStory(c, c.story || "");
  renderChoices(c, c.choices || []);
  setStatus("Loaded.");
}

function wipeMenu() {
  const c = findCampaign(getActiveId());

  const msg =
`Wipe options:

1) Wipe ENTIRE library (all stories)
2) Wipe CURRENT story only
3) Wipe LAST chapter only (undo one)

Type 1, 2, or 3 (Cancel to abort).`;

  const pick = prompt(msg);
  if (!pick) return;

  if (pick.trim() === "1") {
    if (!confirm("Delete ALL campaigns stored on this device?")) return;
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_ACTIVE);
    stopNarration();
    showSetup();
    alert("Library wiped.");
    return;
  }

  if (pick.trim() === "2") {
    if (!c) return alert("No active story.");
    if (!confirm(`Delete "${c.name}" from this device?`)) return;
    removeCampaign(c.id);
    stopNarration();
    showSetup();
    alert("Story deleted.");
    return;
  }

  if (pick.trim() === "3") {
    if (!c) return alert("No active story.");
    undo();
    return;
  }

  alert("Invalid choice.");
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

// ---------- boot ----------
function boot() {
  // restore saved inputs
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode = localStorage.getItem(LS_NARR_MODE) || "openai";
  const savedLocalVoice = localStorage.getItem(LS_LOCAL_VOICE) || "auto";

  if (UI.workerUrl && savedStory) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl && savedTts) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;

  // wire persistence
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));
  UI.localVoice && UI.localVoice.addEventListener("change", () => pickLocalVoiceObj());

  // load voices (iOS loads late)
  if (speechSupported()) {
    speechSynthesis.onvoiceschanged = () => {
      loadLocalVoicesIntoDropdown();
      if (UI.localVoice && savedLocalVoice) UI.localVoice.value = savedLocalVoice;
      pickLocalVoiceObj();
    };
    setTimeout(() => {
      loadLocalVoicesIntoDropdown();
      if (UI.localVoice && savedLocalVoice) UI.localVoice.value = savedLocalVoice;
      pickLocalVoiceObj();
    }, 400);
  }

  // restore active campaign
  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;
  if (c) {
    showPlay(c);
    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
    renderStory(c, c.story || "");
    renderChoices(c, c.choices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeMenu);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => {
    stopNarration();
    showSetup();
    setStatus("Ready.");
  });

  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = () => pauseResumeNarrationToggle().catch(()=>{}));
  UI.stopBtn && (UI.stopBtn.onclick = () => { stopNarration(); setStatus("Ready."); });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  // service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
