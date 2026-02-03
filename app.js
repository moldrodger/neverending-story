/* Neverending Story – app.js (iOS-safe narration, fixed Abort bug)
   - Story Worker: POST { action, memory } -> { story_text, choices[], memory_capsule }
   - TTS Worker:  POST { text, voice }     -> { audio_base64 }
   - OpenAI TTS playback: <audio> + Blob URL (no decodeAudioData)
*/

const LS_KEY = "nes_campaigns_v7";
const LS_ACTIVE = "nes_active_campaign_v7";

const LS_STORY_URL = "nes_story_worker_url";
const LS_TTS_URL   = "nes_tts_worker_url";
const LS_TTS_VOICE = "nes_tts_voice";
const LS_NARR_MODE = "nes_narr_mode"; // off | local | openai
const LS_LOCAL_VOICE = "nes_local_voice";

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

// ---------------- Storage helpers ----------------
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
  UI.campaignPill && (UI.campaignPill.textContent = c.name || "Untitled");
  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
}
function setBusy(b) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(x => { if (x) x.disabled = b; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(btn => btn.disabled = b);
  if (UI.replayBtn) UI.replayBtn.disabled = b; // prevent spam while generating
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

// ---------------- Local speech (free) ----------------
let localVoices = [];
let bestEnglishVoice = null;

function initLocalVoices() {
  if (!("speechSynthesis" in window)) return;
  localVoices = speechSynthesis.getVoices() || [];
  const en = localVoices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  bestEnglishVoice =
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    localVoices[0] ||
    null;

  if (UI.localVoice) {
    UI.localVoice.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Auto (best English)";
    UI.localVoice.appendChild(auto);

    en.forEach(v => {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      UI.localVoice.appendChild(o);
    });

    UI.localVoice.value = localStorage.getItem(LS_LOCAL_VOICE) || "auto";
  }
}

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = initLocalVoices;
  setTimeout(initLocalVoices, 300);
}

function localStop() { try { speechSynthesis.cancel(); } catch {} }

function localPauseResume() {
  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
    else speechSynthesis.pause();
  } catch {}
}

function localSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const clean = String(text || "").trim();
  if (!clean) return;

  localStop();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";

  const pick = UI.localVoice?.value || "auto";
  if (pick !== "auto") {
    const v = (localVoices || []).find(x => x.name === pick);
    if (v) u.voice = v;
  } else if (bestEnglishVoice) {
    u.voice = bestEnglishVoice;
  }

  speechSynthesis.speak(u);
}

// ---------------- OpenAI TTS via <audio> Blob (fixed abort logic) ----------------
const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.playsInline = true;

let currentBlobUrl = null;
let currentAbort = null;
let ttsToken = 0;

function cleanupBlobUrl() {
  if (currentBlobUrl) {
    try { URL.revokeObjectURL(currentBlobUrl); } catch {}
    currentBlobUrl = null;
  }
}

function abortInFlightTTS() {
  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }
}

function stopOpenAITTS() {
  abortInFlightTTS();
  try { audioEl.pause(); } catch {}
  try { audioEl.currentTime = 0; } catch {}
  audioEl.src = "";
  cleanupBlobUrl();
}

function pauseResumeOpenAITTS() {
  try {
    if (!audioEl.src) return;
    if (audioEl.paused) audioEl.play();
    else audioEl.pause();
  } catch {}
}

function base64ToBlobUrl(b64, mime = "audio/mpeg") {
  const clean = String(b64 || "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

async function fetchAndPlayOpenAITTS(ttsUrl, voice, text) {
  const my = ++ttsToken;

  // cancel any prior request/playback, but DO NOT change tokens here
  stopOpenAITTS();

  currentAbort = new AbortController();

  setStatus(`Narrating… (requesting audio, ${text.length} chars)`);

  const res = await fetch(ttsUrl, {
    method: "POST",
    signal: currentAbort.signal,
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ text, voice }),
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch {
    throw new Error("TTS worker returned non-JSON (wrong URL or Worker crashed).");
  }

  if (!res.ok) {
    throw new Error(json?.error || `TTS HTTP ${res.status}`);
  }

  // If a newer narration started, ignore this one
  if (my !== ttsToken) return;

  const b64 = json.audio_base64;
  if (!b64) throw new Error("TTS worker returned no audio_base64.");

  setStatus("Narrating… (playing audio)");

  cleanupBlobUrl();
  currentBlobUrl = base64ToBlobUrl(b64, "audio/mpeg");
  audioEl.src = currentBlobUrl;

  const p = audioEl.play();
  if (p && typeof p.then === "function") {
    await p;
  }

  if (my !== ttsToken) return;
  setStatus("Ready.");
}

// ---------------- Narration routing ----------------
function getNarrMode() {
  return (UI.narrationMode?.value || localStorage.getItem(LS_NARR_MODE) || "off");
}

function narrate(text) {
  const mode = getNarrMode();
  const clean = String(text || "").trim();
  if (!clean) return;

  // stop both pipelines, then run chosen one
  localStop();
  stopOpenAITTS();

  if (mode === "local") {
    setStatus("Narrating… (local)");
    localSpeak(clean);
    setStatus("Ready.");
    return;
  }

  if (mode === "openai") {
    const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
    const voice = (UI.ttsVoice?.value || "alloy").trim();
    if (!ttsUrl) {
      setStatus("Ready (no audio): missing TTS Worker URL");
      return;
    }

    fetchAndPlayOpenAITTS(ttsUrl, voice, clean).catch(e => {
      console.error(e);
      if (e?.name === "AbortError") {
        setStatus("Ready (no audio): canceled");
      } else {
        setStatus("Ready (no audio): " + (e.message || String(e)));
      }
    });
  }
}

// ---------------- Rendering ----------------
function renderStory(text) {
  const clean = String(text || "").trim();
  UI.storyText && (UI.storyText.textContent = clean);
  narrate(clean);
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
  const storyUrl = (UI.workerUrl?.value || "").trim();
  if (!storyUrl) return alert("Enter your Story Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  // persist settings
  localStorage.setItem(LS_STORY_URL, storyUrl);
  localStorage.setItem(LS_TTS_URL, (UI.ttsWorkerUrl?.value || "").trim());
  localStorage.setItem(LS_TTS_VOICE, (UI.ttsVoice?.value || "alloy"));
  localStorage.setItem(LS_NARR_MODE, (UI.narrationMode?.value || "off"));
  if (UI.localVoice) localStorage.setItem(LS_LOCAL_VOICE, UI.localVoice.value);

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();

  const c = {
    id: uuid(),
    name,
    workerUrl: storyUrl,
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
    const json = await callStoryWorker(storyUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.storyText || "";
    c.choices = parsed.choices || [];
    c.memoryCapsule = parsed.memoryCapsule || "";
    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
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
    localStop();
    stopOpenAITTS();

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
    renderStory(c.story);
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

function replay() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  narrate(c.story || "");
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
  localStop();
  stopOpenAITTS();
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
  // restore saved inputs
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode = localStorage.getItem(LS_NARR_MODE) || "off";

  if (UI.workerUrl && savedStory) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl && savedTts) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;

  if (UI.localVoice) UI.localVoice.value = localStorage.getItem(LS_LOCAL_VOICE) || "auto";

  // persist on change
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));
  UI.localVoice && UI.localVoice.addEventListener("change", () => localStorage.setItem(LS_LOCAL_VOICE, UI.localVoice.value));

  // restore active campaign
  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;
  if (c) {
    showPlay(c);
    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
    renderStory(c.story || "");
    renderChoices(c, c.choices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // wire buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeAll);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => {
    localStop();
    stopOpenAITTS();
    showSetup();
    setStatus("Ready.");
  });

  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = () => {
    const mode = getNarrMode();
    if (mode === "local") localPauseResume();
    if (mode === "openai") pauseResumeOpenAITTS();
  });

  UI.stopBtn && (UI.stopBtn.onclick = () => {
    localStop();
    stopOpenAITTS();
    setStatus("Ready.");
  });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
