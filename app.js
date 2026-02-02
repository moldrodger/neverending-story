/* Neverending Story – app.js (iPhone-safe narration)
   OpenAI TTS FIX: TTS worker returns audio/mpeg bytes (not base64 JSON)
*/

const LS_KEY = "nes_campaigns_v7";
const LS_ACTIVE = "nes_active_campaign_v7";

const LS_STORY_URL  = "nes_story_worker_url";
const LS_TTS_URL    = "nes_tts_worker_url";
const LS_TTS_VOICE  = "nes_tts_voice";
const LS_NARR_MODE  = "nes_narr_mode";
const LS_LOCALVOICE = "nes_local_voice";

const OPENAI_TTS_MAX_CHARS = 1200;

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

// ---------------- Storage ----------------
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

// ---------------- UI helpers ----------------
function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }
function showSetup() {
  UI.setupCard && (UI.setupCard.style.display = "");
  UI.playCard && (UI.playCard.style.display = "none");
  UI.campaignPill && (UI.campaignPill.textContent = "No campaign");
}
function showPlay(c) {
  UI.setupCard && (UI.setupCard.style.display = "none");
  UI.playCard && (UI.playCard.style.display = "");
  UI.campaignPill && (UI.campaignPill.textContent = c?.name || "Untitled");
  UI.memoryBox && (UI.memoryBox.textContent = c?.memoryCapsule || "");
}
function setBusy(b) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(x => { if (x) x.disabled = b; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(btn => btn.disabled = b);
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------- Fetch helper w/ timeout ----------------
async function fetchWithTimeout(url, opts, ms, label) {
  const ctrl = ("AbortController" in window) ? new AbortController() : null;
  const finalOpts = ctrl ? { ...opts, signal: ctrl.signal } : opts;

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      try { ctrl && ctrl.abort(); } catch {}
      reject(new Error(`${label}: timed out after ${ms}ms`));
    }, ms);
  });

  const fetchPromise = (async () => {
    return await fetch(url, finalOpts);
  })();

  return Promise.race([fetchPromise, timeoutPromise]);
}

// ---------------- Story worker ----------------
async function callStoryWorker(url, payload) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  }, 25000, "Story worker");

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); }
  catch { throw new Error("Story worker returned non-JSON (first 200): " + txt.slice(0, 200)); }

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

// ---------------- Narration text prep ----------------
function buildNarrationText(storyText) {
  let t = String(storyText || "").replace(/\r/g, "").trim();
  if (t.length > OPENAI_TTS_MAX_CHARS) t = t.slice(0, OPENAI_TTS_MAX_CHARS).trim() + "…";
  return t;
}

// ---------------- Local speech (Free iPhone) ----------------
let localVoices = [];
function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}
function refreshLocalVoices() {
  if (!speechSupported() || !UI.localVoice) return;

  localVoices = speechSynthesis.getVoices() || [];
  const current = UI.localVoice.value || "auto";
  UI.localVoice.innerHTML = "";

  const optAuto = document.createElement("option");
  optAuto.value = "auto";
  optAuto.textContent = "Auto (best English)";
  UI.localVoice.appendChild(optAuto);

  const english = localVoices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  for (const v of english) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    UI.localVoice.appendChild(o);
  }

  UI.localVoice.value = current;
  if (UI.localVoice.value !== current) UI.localVoice.value = "auto";
}
if (speechSupported()) {
  speechSynthesis.onvoiceschanged = refreshLocalVoices;
  setTimeout(refreshLocalVoices, 300);
  setTimeout(refreshLocalVoices, 1000);
}

function pickLocalVoice(nameOrAuto) {
  if (!speechSupported()) return null;
  if (!localVoices.length) localVoices = speechSynthesis.getVoices() || [];
  if (nameOrAuto && nameOrAuto !== "auto") return localVoices.find(v => v.name === nameOrAuto) || null;

  const english = localVoices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  return (
    english.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    english.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    english[0] || localVoices[0] || null
  );
}
function stopLocal() { if (speechSupported()) { try { speechSynthesis.cancel(); } catch {} } }
function pauseLocal() { if (speechSupported()) { try { if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause(); } catch {} } }
function resumeLocal() { if (speechSupported()) { try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {} } }
function speakLocal(text) {
  if (!speechSupported()) return;
  const clean = String(text || "").trim();
  if (!clean) return;

  stopLocal();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;

  const chosen = pickLocalVoice(UI.localVoice?.value || "auto");
  if (chosen) u.voice = chosen;

  try { speechSynthesis.speak(u); } catch {}
}

// ---------------- OpenAI TTS via WebAudio (MP3 bytes) ----------------
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
window.addEventListener("pointerdown", () => { unlockAudioOnce(); }, { once: true });

function stopOpenAi() {
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

async function playBuffer(buf) {
  const ctx = ensureAudioContext();
  await unlockAudioOnce();
  await resumeOpenAi();

  stopOpenAi();

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buf;
  sourceNode.connect(gainNode);
  sourceNode.start(0);
}

function getNarrMode() { return (UI.narrationMode?.value || "off"); }
function stopNarration() { stopLocal(); stopOpenAi(); }

async function fetchAndPlayOpenAi(storyText) {
  const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
  if (!ttsUrl) throw new Error("TTS Worker URL is blank.");

  const voice = (UI.ttsVoice?.value || "alloy");
  const text = buildNarrationText(storyText);
  if (!text) return;

  const my = ++narrToken;
  stopOpenAi();

  setStatus(`Narrating… (requesting audio, ${text.length} chars)`);

  const res = await fetchWithTimeout(ttsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, voice }),
  }, 20000, "TTS worker");

  if (my !== narrToken) return;

  // If worker returned JSON error instead of audio, read it and show it
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const t = await res.text();
    let j;
    try { j = JSON.parse(t); } catch { j = { error: t }; }
    const extra = j?.status ? ` (upstream ${j.status})` : "";
    const raw = j?.raw ? ` raw=${truncate(JSON.stringify(j.raw), 180)}` : "";
    throw new Error(`${j?.error || `HTTP ${res.status}`}${extra}${raw}`);
  }

  if (ct.includes("application/json")) {
    const t = await res.text();
    let j;
    try { j = JSON.parse(t); } catch { j = { error: t }; }
    throw new Error(`TTS returned JSON, not audio: ${j?.error || t.slice(0, 120)}`);
  }

  const audioBuf = await res.arrayBuffer();

  setStatus("Narrating… (decoding audio)");

  const ctx = ensureAudioContext();
  await unlockAudioOnce();

  const decoded = await new Promise((resolve, reject) => {
    ctx.decodeAudioData(audioBuf.slice(0), resolve, reject);
  });

  if (my !== narrToken) return;

  lastBuffer = decoded;
  await playBuffer(decoded);

  setStatus("Ready.");
}

async function narrate(storyText) {
  const mode = getNarrMode();
  const clean = String(storyText || "").trim();
  if (!clean || mode === "off") return;

  if (mode === "local") {
    setStatus("Narrating… (local)");
    speakLocal(buildNarrationText(clean));
    setStatus("Ready.");
    return;
  }

  if (mode === "openai") {
    await unlockAudioOnce();
    await fetchAndPlayOpenAi(clean);
  }
}

// ---------------- Rendering ----------------
function renderStory(c, text) {
  const clean = String(text || "").trim();
  UI.storyText && (UI.storyText.textContent = clean);

  narrate(clean).catch(e => {
    console.error(e);
    setStatus(`Ready (no audio) — ${e.message || String(e)}`);
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
  await unlockAudioOnce();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  localStorage.setItem(LS_STORY_URL, workerUrl);
  localStorage.setItem(LS_TTS_URL, (UI.ttsWorkerUrl?.value || "").trim());
  localStorage.setItem(LS_TTS_VOICE, (UI.ttsVoice?.value || "alloy"));
  localStorage.setItem(LS_NARR_MODE, (UI.narrationMode?.value || "off"));
  localStorage.setItem(LS_LOCALVOICE, (UI.localVoice?.value || "auto"));

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();

  const c = { id: uuid(), name, workerUrl, rating, pacing, story: "", choices: [], memoryCapsule: "", segments: [] };

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
  await unlockAudioOnce();

  setBusy(true);
  setStatus("Generating…");
  try {
    stopNarration();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";

    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });

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
  await unlockAudioOnce();
  const c = findCampaign(getActiveId());
  if (!c) return;

  const mode = getNarrMode();
  if (mode === "openai" && lastBuffer) {
    setStatus("Narrating… (replay cached)");
    playBuffer(lastBuffer)
      .then(() => setStatus("Ready."))
      .catch((e) => setStatus(`Ready (no audio) — ${e.message || String(e)}`));
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

  upsertCampaign(c);
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

  renderStory(c, c.story || "");
  renderChoices(c, c.choices || []);
  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
  setStatus("Loaded.");
}

function wipeMenu() {
  const c = findCampaign(getActiveId());
  const msg =
`Wipe options:
1) Wipe ENTIRE library (all campaigns)
2) Wipe CURRENT story (remove this campaign)
3) Wipe LAST chapter only (undo)

Type 1, 2, or 3:`;

  const pick = prompt(msg);
  const n = parseInt(pick || "", 10);

  if (n === 1) {
    if (!confirm("Delete ALL campaigns stored on this device?")) return;
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_ACTIVE);
    stopNarration();
    showSetup();
    alert("Library wiped.");
    return;
  }

  if (n === 2) {
    if (!c) return alert("No active campaign.");
    if (!confirm(`Delete campaign: "${c.name}" ?`)) return;
    removeCampaign(c.id);
    stopNarration();
    showSetup();
    alert("Campaign wiped.");
    return;
  }

  if (n === 3) {
    if (!c) return alert("No active campaign.");
    undo();
  }
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
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts   = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode  = localStorage.getItem(LS_NARR_MODE) || "off";
  const savedLocal = localStorage.getItem(LS_LOCALVOICE) || "auto";

  if (UI.workerUrl && savedStory) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl && savedTts) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;

  refreshLocalVoices();
  setTimeout(refreshLocalVoices, 800);
  if (UI.localVoice) UI.localVoice.value = savedLocal;

  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));
  UI.localVoice && UI.localVoice.addEventListener("change", () => localStorage.setItem(LS_LOCALVOICE, UI.localVoice.value));

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c, c.story || "");
    renderChoices(c, c.choices || []);
    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeMenu);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => { stopNarration(); showSetup(); setStatus("Ready."); });
  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = async () => {
    await unlockAudioOnce();
    const mode = getNarrMode();
    if (mode === "openai") {
      const ctx = ensureAudioContext();
      if (ctx.state === "running") await pauseOpenAi();
      else await resumeOpenAi();
    } else if (mode === "local") {
      if (speechSupported() && speechSynthesis.paused) resumeLocal();
      else pauseLocal();
    }
    setStatus("Ready.");
  });

  UI.stopBtn && (UI.stopBtn.onclick = async () => {
    await unlockAudioOnce();
    stopNarration();
    setStatus("Ready.");
  });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
