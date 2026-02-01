/* Neverending Story – app.js (iPhone-safe Narration: Local + OpenAI TTS)
   - Story worker expects JSON: { story_text, choices[], memory_capsule }
     (also supports { text: "...tagged..." } fallback)
   - Narration modes:
       off   = no audio
       local = iPhone SpeechSynthesis (free)
       openai= Cloudflare TTS worker (OpenAI TTS -> returns audio_base64)
   - iOS reliability:
       * clamps narration text
       * hard timeout + abort for TTS fetch
       * step-by-step status so we know where it’s stuck
       * WebAudio playback (iOS-safe)
*/

const LS_KEY = "nes_campaigns_v6";
const LS_ACTIVE = "nes_active_campaign_v6";

const LS_STORY_URL = "nes_story_worker_url";
const LS_TTS_URL   = "nes_tts_worker_url";
const LS_TTS_VOICE = "nes_tts_voice";
const LS_NARR_MODE = "nes_narr_mode";

const el = (id) => document.getElementById(id);

const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  // setup inputs
  workerUrl: el("workerUrl"),
  ttsWorkerUrl: el("ttsWorkerUrl"),
  narrationMode: el("narrationMode"), // off | local | openai
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

// ---------------- Storage helpers ----------------
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
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c; else list.unshift(c);
  saveAll(list);
}
function uuid() { return crypto.randomUUID(); }

// ---------------- UI helpers ----------------
function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }
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
function setBusy(b) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(x => { if (x) x.disabled = b; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(btn => btn.disabled = b);
}

// ---------------- Story worker ----------------
async function callStoryWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); }
  catch { throw new Error("Story worker returned non-JSON."); }

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

  // Tagged fallback: { text: "[STORY]...\n[CHOICES]...\n[MEMORY]..." }
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

// ---------------- Narration: Shared helpers ----------------
let lastNarratedText = "";
let lastBuffer = null;

// Clamp narration so iOS doesn’t choke on huge base64 MP3
function clampNarrationText(text, maxChars = 1600) {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;

  const cut = t.slice(0, maxChars);
  const lastPeriod = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastPeriod > 300 ? cut.slice(0, lastPeriod + 1) : cut) + "…";
}

// ---------------- Narration: Local speechSynthesis ----------------
function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}
let speechUnlocked = false;
let selectedVoice = null;

function loadVoices() {
  if (!speechSupported()) return;
  const voices = speechSynthesis.getVoices();
  if (!voices?.length) return;

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

  // iOS: must happen after a user gesture
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch {}

  speechUnlocked = true;
  loadVoices();
  setTimeout(loadVoices, 250);
  setTimeout(loadVoices, 750);
}

if (speechSupported()) {
  speechSynthesis.onvoiceschanged = () => loadVoices();
}

// iOS sometimes needs double cancel
function hardStopSpeech() {
  if (!speechSupported()) return;
  try { speechSynthesis.cancel(); } catch {}
  setTimeout(() => { try { speechSynthesis.cancel(); } catch {} }, 0);
}

let speakToken = 0;
function speakLocal(text) {
  if (!speechSupported()) return;
  if (!speechUnlocked) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  const my = ++speakToken;
  hardStopSpeech();

  setTimeout(() => {
    if (my !== speakToken) return;
    hardStopSpeech();

    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "en-US";
    if (selectedVoice) u.voice = selectedVoice;
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;

    try { speechSynthesis.speak(u); } catch {}
  }, 80);
}

function pauseLocal() {
  if (!speechSupported()) return;
  try { if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause(); } catch {}
}
function resumeLocal() {
  if (!speechSupported()) return;
  try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
}
function stopLocal() { hardStopSpeech(); }

// ---------------- Narration: OpenAI TTS via WebAudio ----------------
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
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

async function pauseOpenAi() {
  const ctx = ensureAudioContext();
  try { if (ctx.state === "running") await ctx.suspend(); } catch {}
}
async function resumeOpenAi() {
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
  await resumeOpenAi();

  stopOpenAiNarration();

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(gainNode);
  sourceNode.start(0);
}

async function fetchAndNarrateOpenAi(text) {
  const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
  if (!ttsUrl) return;

  const voice = (UI.ttsVoice?.value || "alloy");
  const narrText = clampNarrationText(text, 1600);
  if (!narrText) return;

  const my = ++narrToken;
  stopOpenAiNarration();

  // Timeout + abort so we never hang forever
  const controller = new AbortController();
  const timeoutMs = 25000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    setStatus("Narrating… (requesting TTS)");
    await unlockAudioOnce();

    setStatus("Narrating… (waiting on worker)");
    const res = await fetch(ttsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ text: narrText, voice }),
    });

    setStatus("Narrating… (downloading response)");
    const txt = await res.text();

    let json;
    try { json = JSON.parse(txt); }
    catch {
      throw new Error("TTS worker returned non-JSON (first 200 chars): " + txt.slice(0, 200));
    }

    if (!res.ok) throw new Error(json?.error || `TTS HTTP ${res.status}`);
    if (my !== narrToken) return;

    const b64 = json.audio_base64;
    if (!b64 || typeof b64 !== "string") throw new Error("TTS worker returned no audio_base64.");

    setStatus(`Narrating… (decoding audio, ${Math.round(b64.length / 1024)} KB base64)`);

    const ctx = ensureAudioContext();
    await unlockAudioOnce();

    const arr = base64ToArrayBuffer(b64);

    const decoded = await new Promise((resolve, reject) => {
      ctx.decodeAudioData(arr.slice(0), resolve, reject);
    });

    if (my !== narrToken) return;

    lastBuffer = decoded;

    setStatus("Narrating… (playing)");
    await playBuffer(decoded);

    setStatus("Ready.");
  } catch (e) {
    const msg = (e?.name === "AbortError")
      ? "TTS timed out (worker/network stalled)."
      : (e?.message || String(e));

    console.error("TTS error:", e);
    setStatus("Ready (no audio): " + msg);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Unified narrate entry
async function narrate(text) {
  const mode = (UI.narrationMode?.value || "off");
  const clean = String(text || "").trim();
  if (!clean) return;

  lastNarratedText = clean;

  if (mode === "off") return;

  if (mode === "local") {
    unlockSpeechOnce();
    speakLocal(clean);
    return;
  }

  if (mode === "openai") {
    await unlockAudioOnce();
    await fetchAndNarrateOpenAi(clean);
    return;
  }
}

// Unified pause/stop/replay based on mode
async function pauseNarration() {
  const mode = (UI.narrationMode?.value || "off");
  if (mode === "local") {
    // toggle pause/resume for local
    if (speechSupported() && speechSynthesis.paused) resumeLocal();
    else pauseLocal();
    return;
  }
  if (mode === "openai") {
    const ctx = ensureAudioContext();
    if (ctx.state === "running") await pauseOpenAi();
    else await resumeOpenAi();
    return;
  }
}

async function stopNarration() {
  const mode = (UI.narrationMode?.value || "off");
  if (mode === "local") stopLocal();
  if (mode === "openai") stopOpenAiNarration();
  setStatus("Ready.");
}

async function replayNarration() {
  const mode = (UI.narrationMode?.value || "off");
  if (mode === "off") return;

  if (mode === "openai" && lastBuffer) {
    setStatus("Narrating… (replay)");
    await unlockAudioOnce();
    await playBuffer(lastBuffer);
    setStatus("Ready.");
    return;
  }

  // fallback (local or openai without buffer)
  if (lastNarratedText) await narrate(lastNarratedText);
}

// Unlock audio+speech on first tap anywhere
window.addEventListener("pointerdown", () => {
  unlockAudioOnce().catch(()=>{});
  unlockSpeechOnce();
}, { once: true });

// ---------------- Rendering ----------------
function renderStory(c, text) {
  const clean = String(text || "").trim();
  if (UI.storyText) UI.storyText.textContent = clean;

  // Always narrate when we render (if mode != off)
  narrate(clean).catch(err => {
    console.error(err);
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

// ---------------- Main actions ----------------
async function startNew() {
  setBusy(true);
  setStatus("Starting...");

  try {
    const workerUrl = (UI.workerUrl?.value || "").trim();
    if (!workerUrl) throw new Error("Enter your Story Worker URL.");

    const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
    const seed = (UI.seed?.value || "").trim();
    if (!seed) throw new Error("Enter a story seed.");

    // persist setup values so you don’t retype
    localStorage.setItem(LS_STORY_URL, workerUrl);
    localStorage.setItem(LS_TTS_URL, (UI.ttsWorkerUrl?.value || "").trim());
    localStorage.setItem(LS_TTS_VOICE, (UI.ttsVoice?.value || "alloy"));
    localStorage.setItem(LS_NARR_MODE, (UI.narrationMode?.value || "off"));

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

    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callStoryWorker(workerUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;
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
  setBusy(true);
  setStatus("Generating...");

  try {
    await stopNarration();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";

    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });

    upsertCampaign(c);

    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule;
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

function undo() {
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

// ---------------- Boot ----------------
function boot() {
  // Restore saved setup values
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode = localStorage.getItem(LS_NARR_MODE) || "off";

  if (UI.workerUrl && savedStory) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl && savedTts) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;

  // Persist changes immediately
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));

  // Restore active campaign
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
    stopNarration();
    showSetup();
    setStatus("Ready.");
  });

  UI.replayBtn && (UI.replayBtn.onclick = () => replayNarration());
  UI.pauseBtn && (UI.pauseBtn.onclick = () => pauseNarration());
  UI.stopBtn && (UI.stopBtn.onclick = () => stopNarration());
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // load voices (iOS loads late)
  if (speechSupported()) {
    setTimeout(() => { try { speechSynthesis.getVoices(); } catch {} }, 300);
  }
}

boot();
