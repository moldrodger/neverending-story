const LS_STORY_URL = "nes_story_worker_url";
const LS_TTS_URL   = "nes_tts_worker_url";
const LS_TTS_VOICE = "nes_tts_voice";
const LS_NARR_MODE = "nes_narr_mode";

const LS_KEY = "nes_campaigns_v7";
const LS_ACTIVE = "nes_active_campaign_v7";

const el = (id) => document.getElementById(id);
const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  ttsWorkerUrl: el("ttsWorkerUrl"),
  narrationMode: el("narrationMode"),
  ttsVoice: el("ttsVoice"),
  localVoice: el("localVoice"),

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

function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }

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
function uuid() { return crypto.randomUUID(); }

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

function getNarrMode() {
  return (UI.narrationMode?.value || localStorage.getItem(LS_NARR_MODE) || "off");
}
function getStoryUrl() {
  return (UI.workerUrl?.value || localStorage.getItem(LS_STORY_URL) || "").trim();
}
function getTtsUrl() {
  return (UI.ttsWorkerUrl?.value || localStorage.getItem(LS_TTS_URL) || "").trim();
}
function getTtsVoice() {
  return (UI.ttsVoice?.value || localStorage.getItem(LS_TTS_VOICE) || "alloy");
}

// ---------- Local speech ----------
function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}
let voicesLoaded = false;

function bestEnglishVoice() {
  if (!speechSupported()) return null;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  if (!en.length) return voices[0];

  // Prefer Siri/Enhanced/etc (when available)
  return (
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0]
  );
}

function stopLocal() { if (speechSupported()) { try { speechSynthesis.cancel(); } catch {} } }
function pauseLocal() { if (speechSupported()) { try { speechSynthesis.pause(); } catch {} } }
function resumeLocal() { if (speechSupported()) { try { speechSynthesis.resume(); } catch {} } }

function speakLocal(text) {
  if (!speechSupported()) throw new Error("speechSynthesis not supported.");
  const clean = String(text || "").trim();
  if (!clean) return;

  stopLocal();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";

  const v = bestEnglishVoice();
  if (v) u.voice = v;

  speechSynthesis.speak(u);
}

// iOS loads voices late
if (speechSupported()) {
  speechSynthesis.onvoiceschanged = () => { voicesLoaded = true; };
  setTimeout(() => { try { speechSynthesis.getVoices(); voicesLoaded = true; } catch {} }, 300);
  setTimeout(() => { try { speechSynthesis.getVoices(); voicesLoaded = true; } catch {} }, 1200);
}

// ---------- OpenAI TTS via WebAudio ----------
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let lastBuffer = null;
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

async function unlockAudio() {
  const ctx = ensureAudioContext();
  if (ctx.state !== "running") {
    try { await ctx.resume(); } catch {}
  }
}
window.addEventListener("pointerdown", () => { unlockAudio(); }, { once: true });

function stopOpenAi() {
  narrToken++;
  try { if (sourceNode) sourceNode.stop(); } catch {}
  sourceNode = null;
}
async function pauseOpenAi() { const ctx = ensureAudioContext(); try { await ctx.suspend(); } catch {} }
async function resumeOpenAi() { const ctx = ensureAudioContext(); try { await ctx.resume(); } catch {} }

function base64ToArrayBuffer(base64) {
  const clean = String(base64 || "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function playBuffer(buf) {
  await unlockAudio();
  stopOpenAi();
  const ctx = ensureAudioContext();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(gainNode);
  sourceNode.start(0);
}

async function openaiNarrate(text) {
  const ttsUrl = getTtsUrl();
  if (!ttsUrl) throw new Error("Missing TTS Worker URL.");

  const voice = getTtsVoice();
  const clean = String(text || "").trim();
  if (!clean) return;

  const my = ++narrToken;
  stopOpenAi();
  await unlockAudio();

  setStatus(`Narrating… (requesting audio, ${clean.length} chars)`);

  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ text: clean, voice }),
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("TTS worker returned non-JSON."); }
  if (!res.ok) throw new Error(json?.error || `OpenAI TTS error (HTTP ${res.status})`);

  if (my !== narrToken) return;

  const b64 = json.audio_base64;
  if (!b64) throw new Error("TTS worker returned no audio_base64.");

  const ctx = ensureAudioContext();
  const arr = base64ToArrayBuffer(b64);

  setStatus("Narrating… (decoding audio)");

  const decoded = await new Promise((resolve, reject) => {
    ctx.decodeAudioData(arr.slice(0), resolve, reject);
  });

  if (my !== narrToken) return;

  lastBuffer = decoded;
  setStatus("Narrating… (playing)");
  await playBuffer(decoded);
  setStatus("Ready.");
}

// ---------- Story worker ----------
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
  return json;
}

function normalizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3);
}
function parseStoryResponse(json) {
  if (!json || typeof json !== "object") return { storyText: "", choices: [], memoryCapsule: "" };
  return {
    storyText: String(json.story_text || "").trim(),
    choices: normalizeChoices(json.choices),
    memoryCapsule: String(json.memory_capsule || "").trim(),
  };
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

function renderStory(text) {
  if (UI.storyText) UI.storyText.textContent = String(text || "").trim();
}
function renderChoices(c, list) {
  if (!UI.choices) return;
  UI.choices.innerHTML = "";

  const choices = normalizeChoices(list);
  if (!choices.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices detected.";
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

async function narrate(text) {
  const mode = getNarrMode();
  if (mode === "off") return;

  if (mode === "local") {
    setStatus("Narrating… (local)");
    stopOpenAi();
    speakLocal(text);
    setStatus("Ready.");
    return;
  }

  if (mode === "openai") {
    stopLocal();
    await openaiNarrate(text);
    return;
  }
}

async function startNew() {
  try {
    const storyUrl = getStoryUrl();
    if (!storyUrl) return alert("Enter your Story Worker URL.");

    const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
    const seed = (UI.seed?.value || "").trim();
    if (!seed) return alert("Enter a story seed.");

    // IMPORTANT: PWA storage is separate from Safari storage on iOS
    localStorage.setItem(LS_STORY_URL, storyUrl);
    localStorage.setItem(LS_TTS_URL, getTtsUrl());
    localStorage.setItem(LS_TTS_VOICE, getTtsVoice());
    localStorage.setItem(LS_NARR_MODE, getNarrMode());

    const rating = (UI.rating?.value || "PG-13").trim();
    const pacing = (UI.pacing?.value || "long").trim();

    const c = { id: uuid(), name, workerUrl: storyUrl, story: "", choices: [], memoryCapsule: "", segments: [] };
    setActive(c.id);
    upsertCampaign(c);
    showPlay(c);

    setStatus("Starting…");
    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callStoryWorker(storyUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText;
    c.choices = parsed.choices;
    c.memoryCapsule = parsed.memoryCapsule;
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    await narrate(c.story);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  }
}

async function advance(c, choiceNumber, actionText) {
  try {
    stopLocal(); stopOpenAi();

    setStatus("Generating…");
    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText;
    c.choices = parsed.choices;
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule;

    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });
    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    await narrate(c.story);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  }
}

async function replay() {
  const c = findCampaign(getActiveId());
  if (!c) return alert("No active campaign loaded.");

  const text = String(c.story || "").trim();
  if (!text) return alert("No story text to replay.");

  try {
    if (getNarrMode() === "openai" && lastBuffer) {
      setStatus("Narrating… (cached)");
      await playBuffer(lastBuffer);
      setStatus("Ready.");
      return;
    }
    await narrate(text);
  } catch (e) {
    console.error(e);
    setStatus("Ready (no audio). " + (e.message || String(e)));
    alert(e.message || String(e));
  }
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
  renderStory(c.story || "");
  renderChoices(c, c.choices || []);
  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("Delete ALL campaigns stored on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  showSetup();
  alert("Local campaigns wiped.");
}

function undo() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  if ((c.segments || []).length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];
  c.story = last?.story || "";
  c.choices = last?.choices || [];
  upsertCampaign(c);
  renderStory(c.story);
  renderChoices(c, c.choices);
  setStatus("Undid last step.");
}

function boot() {
  // restore saved inputs
  const story = localStorage.getItem(LS_STORY_URL) || "";
  const tts = localStorage.getItem(LS_TTS_URL) || "";
  const voice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const mode = localStorage.getItem(LS_NARR_MODE) || "off";

  if (UI.workerUrl && story) UI.workerUrl.value = story;
  if (UI.ttsWorkerUrl && tts) UI.ttsWorkerUrl.value = tts;
  if (UI.ttsVoice) UI.ttsVoice.value = voice;
  if (UI.narrationMode) UI.narrationMode.value = mode;

  // restore active campaign
  const c = getActiveId() ? findCampaign(getActiveId()) : null;
  if (c) {
    showPlay(c);
    renderStory(c.story || "");
    renderChoices(c, c.choices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // wire buttons (null-safe)
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeAll);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => { stopLocal(); stopOpenAi(); showSetup(); setStatus("Ready."); });
  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = async () => {
    const mode = getNarrMode();
    if (mode === "local") {
      if (speechSynthesis?.paused) resumeLocal(); else pauseLocal();
      return;
    }
    if (mode === "openai") {
      const ctx = ensureAudioContext();
      if (ctx.state === "running") await pauseOpenAi();
      else await resumeOpenAi();
    }
  });

  UI.stopBtn && (UI.stopBtn.onclick = () => { stopLocal(); stopOpenAi(); setStatus("Ready."); });

  UI.continueBtn && (UI.continueBtn.onclick = () => {
    const c = findCampaign(getActiveId()); if (!c) return;
    advance(c, 0, "Continue.");
  });

  UI.wildBtn && (UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId()); if (!c) return;
    const t = (UI.wildInput?.value || "").trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advance(c, 0, t);
  });

  // persist dropdown changes
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
}

boot();
