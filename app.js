/* Neverending Story – app.js (Replay + narration mode fix)
   - Fix: Replay now uses CURRENT dropdown mode, not stale saved campaign flags
   - Supports narrationMode: off | local | openai
   - local = speechSynthesis (free iPhone voice)
   - openai = TTS worker returning JSON { audio_base64 }
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

// ---------- Storage ----------
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

// ---------- UI ----------
function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }
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

// ---------- Story Worker ----------
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

  // Tagged fallback
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

// ---------- Narration Mode (LIVE, not stale) ----------
function getNarrationMode() {
  return (UI.narrationMode?.value || localStorage.getItem(LS_NARR_MODE) || "off");
}
function getTtsUrl() {
  return (UI.ttsWorkerUrl?.value || localStorage.getItem(LS_TTS_URL) || "").trim();
}
function getTtsVoice() {
  return (UI.ttsVoice?.value || localStorage.getItem(LS_TTS_VOICE) || "alloy");
}

// ---------- Local Speech (free iPhone voice) ----------
let localVoice = null;
function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}
function loadLocalVoices() {
  if (!speechSupported()) return;
  const voices = speechSynthesis.getVoices() || [];
  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  localVoice =
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    voices[0] ||
    null;
}
if (speechSupported()) {
  speechSynthesis.onvoiceschanged = loadLocalVoices;
  setTimeout(loadLocalVoices, 250);
}

function speakLocal(text) {
  if (!speechSupported()) return;
  const clean = String(text || "").trim();
  if (!clean) return;
  try { speechSynthesis.cancel(); } catch {}
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";
  if (localVoice) u.voice = localVoice;
  speechSynthesis.speak(u);
}
function stopLocal() { if (speechSupported()) { try { speechSynthesis.cancel(); } catch {} } }
function pauseLocal() { if (speechSupported()) { try { speechSynthesis.pause(); } catch {} } }
function resumeLocal() { if (speechSupported()) { try { speechSynthesis.resume(); } catch {} } }

// ---------- OpenAI TTS (JSON audio_base64) + WebAudio decode ----------
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

async function fetchOpenAiTts(text) {
  const ttsUrl = getTtsUrl();
  if (!ttsUrl) throw new Error("Missing TTS Worker URL.");

  const voice = getTtsVoice();
  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ text, voice }),
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("TTS worker returned non-JSON."); }
  if (!res.ok) throw new Error(json?.error || `OpenAI TTS error (HTTP ${res.status})`);

  const b64 = json.audio_base64;
  if (!b64) throw new Error("No audio_base64 returned.");

  const ctx = ensureAudioContext();
  await unlockAudio();
  const arr = base64ToArrayBuffer(b64);

  const decoded = await new Promise((resolve, reject) => {
    ctx.decodeAudioData(arr.slice(0), resolve, reject);
  });

  lastBuffer = decoded;
  await playBuffer(decoded);
}

// ---------- Narrate (central) ----------
async function narrate(text) {
  const mode = getNarrationMode();
  const clean = String(text || "").trim();
  if (!clean) return;

  // invalidate older in-flight narration
  const my = ++narrToken;

  if (mode === "off") return;

  if (mode === "local") {
    setStatus("Narrating… (local)");
    stopOpenAi();
    speakLocal(clean);
    setStatus("Ready.");
    return;
  }

  if (mode === "openai") {
    setStatus(`Narrating… (OpenAI, ${clean.length} chars)`);
    stopLocal();
    stopOpenAi();
    await unlockAudio();

    // If another narration started, bail out
    if (my !== narrToken) return;

    await fetchOpenAiTts(clean);
    if (my !== narrToken) return;

    setStatus("Ready.");
    return;
  }
}

// ---------- Rendering ----------
function renderStory(text) {
  const clean = String(text || "").trim();
  UI.storyText && (UI.storyText.textContent = clean);
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

// ---------- Actions ----------
async function startNew() {
  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  // persist inputs so you don't retype
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

  setBusy(true);
  setStatus("Starting…");
  try {
    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callStoryWorker(workerUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    // ✅ auto-narrate new chapter
    await narrate(c.story);

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
  setStatus("Generating…");
  try {
    // stop any current narration immediately
    stopLocal();
    stopOpenAi();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";

    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });
    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    // ✅ auto-narrate new chapter
    await narrate(c.story);

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
  const c = findCampaign(getActiveId());
  if (!c) return alert("No active campaign loaded.");

  const text = String(c.story || "").trim();
  if (!text) return alert("No story text to replay yet.");

  try {
    // If OpenAI mode and we have lastBuffer, replay instantly
    if (getNarrationMode() === "openai" && lastBuffer) {
      setStatus("Narrating… (cached)");
      await playBuffer(lastBuffer);
      setStatus("Ready.");
      return;
    }

    await narrate(text);
  } catch (e) {
    console.error(e);
    setStatus("Ready (no audio).");
    alert(e.message || String(e));
  }
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
  // restore saved inputs
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts   = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode  = localStorage.getItem(LS_NARR_MODE) || "off";

  if (UI.workerUrl && savedStory) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl && savedTts) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;

  // live-persist dropdown changes
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));

  // restore active campaign
  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c.story || "");
    renderChoices(c, c.choices || []);
    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeAll);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => { stopLocal(); stopOpenAi(); showSetup(); setStatus("Ready."); });

  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = async () => {
    const mode = getNarrationMode();
    if (mode === "local") {
      if (speechSynthesis?.paused) resumeLocal(); else pauseLocal();
      return;
    }
    if (mode === "openai") {
      const ctx = ensureAudioContext();
      if (ctx.state === "running") await pauseOpenAi();
      else await resumeOpenAi();
      return;
    }
  });

  UI.stopBtn && (UI.stopBtn.onclick = () => { stopLocal(); stopOpenAi(); setStatus("Ready."); });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);
}

boot();
