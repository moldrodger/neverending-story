/* Neverending Story – app.js (iPhone-safe narration)
   - Narration modes: Off / Local (speechSynthesis) / OpenAI TTS worker (audio_base64)
   - Fixes "hang at requesting audio" by:
       * AbortController timeouts
       * cache: "no-store"
       * better error surfacing
       * blob URL playback (more iOS reliable than data: URLs)
   - Buttons: Library / Replay / Pause-Resume / Stop / Undo
   - Wipe: choose wipe library / wipe current story / wipe last chapter
   - Remembers URLs + settings in localStorage
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

// ---------------- Storage ----------------
function loadAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
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
function removeCampaign(id) {
  const list = loadAll().filter(c => c.id !== id);
  saveAll(list);
  if (getActiveId() === id) localStorage.removeItem(LS_ACTIVE);
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
}

// ---------------- Helpers (timeouts) ----------------
async function fetchJsonWithTimeout(url, opts, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); }
    catch { throw new Error(`${label}: non-JSON response (first 200 chars): ${txt.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`${label}: ${json?.error || `HTTP ${res.status}`}`);
    return json;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`${label}: timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Story worker ----------------
async function callStoryWorker(url, payload) {
  return fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      mode: "cors",
      cache: "no-store",
    },
    20000,
    "Story worker"
  );
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

  // Tagged fallback: { text: "[STORY]..[CHOICES]..[MEMORY].." }
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

// ---------------- Narration: LOCAL (speechSynthesis) ----------------
function localSpeechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}
let localSelectedVoice = null;

function refreshLocalVoices() {
  if (!localSpeechSupported()) return;

  const voices = speechSynthesis.getVoices() || [];
  // Populate dropdown once we have voices
  if (UI.localVoice && voices.length) {
    const current = UI.localVoice.value || "auto";
    UI.localVoice.innerHTML = "";

    const optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "Auto (best English)";
    UI.localVoice.appendChild(optAuto);

    voices.forEach((v) => {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      UI.localVoice.appendChild(o);
    });

    UI.localVoice.value = current;
  }

  pickLocalVoice();
}

function pickLocalVoice() {
  if (!localSpeechSupported()) return;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return;

  const wanted = (UI.localVoice?.value || "auto");
  if (wanted !== "auto") {
    localSelectedVoice = voices.find(v => v.name === wanted) || null;
    return;
  }

  // Auto: best English-ish voice
  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  localSelectedVoice =
    en.find(v => /siri|enhanced|premium|neural|natural/i.test(v.name)) ||
    en.find(v => (v.lang || "").toLowerCase() === "en-us") ||
    en[0] ||
    voices[0] ||
    null;
}

function stopLocalSpeech() {
  if (!localSpeechSupported()) return;
  try { speechSynthesis.cancel(); } catch {}
}
function pauseLocalSpeech() {
  if (!localSpeechSupported()) return;
  try { if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause(); } catch {}
}
function resumeLocalSpeech() {
  if (!localSpeechSupported()) return;
  try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch {}
}
function speakLocal(text) {
  if (!localSpeechSupported()) return;
  const clean = String(text || "").trim();
  if (!clean) return;

  stopLocalSpeech();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";
  if (localSelectedVoice) u.voice = localSelectedVoice;
  try { speechSynthesis.speak(u); } catch {}
}

// ---------------- Narration: OPENAI TTS (blob audio) ----------------
let audioEl = null;
let lastObjectUrl = null;
let lastNarratedText = "";
let narrToken = 0;

function ensureAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "auto";
    audioEl.playsInline = true; // iOS inline
  }
  return audioEl;
}

function cleanupObjectUrl() {
  if (lastObjectUrl) {
    try { URL.revokeObjectURL(lastObjectUrl); } catch {}
    lastObjectUrl = null;
  }
}

function base64ToBlob(base64, mime = "audio/mpeg") {
  const clean = String(base64 || "").replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function stopOpenAiAudio() {
  narrToken++;
  const a = ensureAudioEl();
  try { a.pause(); } catch {}
  try { a.currentTime = 0; } catch {}
  cleanupObjectUrl();
}

async function pauseOpenAiAudio() {
  const a = ensureAudioEl();
  try { a.pause(); } catch {}
}

async function resumeOpenAiAudio() {
  const a = ensureAudioEl();
  try { await a.play(); } catch {}
}

async function narrateOpenAI(text) {
  const ttsUrl = (UI.ttsWorkerUrl?.value || "").trim();
  if (!ttsUrl) throw new Error("Missing TTS Worker URL.");

  const voice = (UI.ttsVoice?.value || "alloy");
  const clean = String(text || "").trim();
  if (!clean) return;

  const my = ++narrToken;
  await stopOpenAiAudio();

  setStatus("Narrating… (requesting audio)");
  const json = await fetchJsonWithTimeout(
    ttsUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ text: clean, voice }),
      mode: "cors",
      cache: "no-store",
    },
    20000,
    "TTS worker"
  );

  if (my !== narrToken) return;

  const b64 = json.audio_base64;
  if (!b64) throw new Error("TTS worker returned no audio_base64.");

  setStatus("Narrating… (preparing audio)");

  const blob = base64ToBlob(b64, "audio/mpeg");
  cleanupObjectUrl();
  lastObjectUrl = URL.createObjectURL(blob);

  const a = ensureAudioEl();
  a.src = lastObjectUrl;

  setStatus("Narrating… (playing)");
  try {
    // Must be triggered by a user gesture; Start/Replay/Choice taps qualify.
    await a.play();
    lastNarratedText = clean;
    setStatus("Ready.");
  } catch (e) {
    // If iOS blocks it, we surface a clear message
    console.error(e);
    throw new Error("Playback blocked. Tap Replay or any Choice once, then try again.");
  }
}

// Unified narration based on mode
async function narrateIfEnabled(text) {
  const mode = (UI.narrationMode?.value || "off");

  if (mode === "off") return;

  if (mode === "local") {
    setStatus("Narrating… (local)");
    speakLocal(text);
    setStatus("Ready.");
    return;
  }

  if (mode === "openai") {
    await narrateOpenAI(text);
  }
}

async function stopAllAudio() {
  stopLocalSpeech();
  await stopOpenAiAudio();
}

async function pauseResumeAudio() {
  const mode = (UI.narrationMode?.value || "off");
  if (mode === "local") {
    if (localSpeechSupported() && speechSynthesis.paused) resumeLocalSpeech();
    else pauseLocalSpeech();
    return;
  }
  if (mode === "openai") {
    const a = ensureAudioEl();
    if (a.paused) await resumeOpenAiAudio();
    else await pauseOpenAiAudio();
  }
}

// ---------------- Rendering ----------------
function renderStory(c, text) {
  const clean = String(text || "").trim();
  UI.storyText && (UI.storyText.textContent = clean);

  // Keep campaign copy updated
  if (c) {
    c.story = clean;
    upsertCampaign(c);
  }

  // Narrate (catch + show real error)
  narrateIfEnabled(clean).catch((e) => {
    console.error(e);
    setStatus(`Ready (no audio): ${e.message || e}`);
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
  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  // Persist settings so you don't retype
  localStorage.setItem(LS_STORY_URL, workerUrl);
  localStorage.setItem(LS_TTS_URL, (UI.ttsWorkerUrl?.value || "").trim());
  localStorage.setItem(LS_TTS_VOICE, (UI.ttsVoice?.value || "alloy"));
  localStorage.setItem(LS_NARR_MODE, (UI.narrationMode?.value || "off"));
  localStorage.setItem(LS_LOCAL_VOICE, (UI.localVoice?.value || "auto"));

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
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
    await stopAllAudio();

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
  setBusy(true);
  setStatus("Generating…");
  try {
    await stopAllAudio();

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
  const c = findCampaign(getActiveId());
  if (!c) return;

  // If OpenAI mode and we last narrated this exact text, just replay the same src
  if ((UI.narrationMode?.value === "openai") && lastNarratedText === (c.story || "").trim()) {
    setStatus("Narrating… (replay)");
    const a = ensureAudioEl();
    try {
      a.currentTime = 0;
      await a.play();
      setStatus("Ready.");
      return;
    } catch (e) {
      console.error(e);
      // fallthrough to re-request
    }
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

  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
  renderStory(c, c.story || "");
  renderChoices(c, c.choices || []);
  setStatus("Loaded.");
}

// Wipe options: library / current story / last chapter
async function wipeMenu() {
  const c = findCampaign(getActiveId());

  const msg =
`Wipe options:

1) Wipe ENTIRE library (all campaigns)
2) Wipe CURRENT story (delete this campaign)
3) Wipe LAST chapter (undo once)

Type 1, 2, or 3:`;

  const pick = prompt(msg);
  const n = parseInt(pick || "", 10);

  if (n === 1) {
    if (!confirm("Delete ALL campaigns stored on this device?")) return;
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_ACTIVE);
    await stopAllAudio();
    showSetup();
    alert("Library wiped.");
    return;
  }

  if (n === 2) {
    if (!c) return alert("No active story to delete.");
    if (!confirm(`Delete story "${c.name}"?`)) return;
    removeCampaign(c.id);
    await stopAllAudio();
    showSetup();
    alert("Story deleted.");
    return;
  }

  if (n === 3) {
    if (!c) return alert("No active story.");
    undo();
    return;
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
  // Restore saved settings
  const savedStory = localStorage.getItem(LS_STORY_URL) || "";
  const savedTts   = localStorage.getItem(LS_TTS_URL) || "";
  const savedVoice = localStorage.getItem(LS_TTS_VOICE) || "alloy";
  const savedMode  = localStorage.getItem(LS_NARR_MODE) || "off";
  const savedLocal = localStorage.getItem(LS_LOCAL_VOICE) || "auto";

  if (UI.workerUrl) UI.workerUrl.value = savedStory;
  if (UI.ttsWorkerUrl) UI.ttsWorkerUrl.value = savedTts;
  if (UI.ttsVoice) UI.ttsVoice.value = savedVoice;
  if (UI.narrationMode) UI.narrationMode.value = savedMode;
  if (UI.localVoice) UI.localVoice.value = savedLocal;

  // Local voices load late on iOS
  if (localSpeechSupported()) {
    speechSynthesis.onvoiceschanged = refreshLocalVoices;
    setTimeout(refreshLocalVoices, 300);
    setTimeout(refreshLocalVoices, 1200);
  }

  // Persist changes immediately
  UI.workerUrl && UI.workerUrl.addEventListener("change", () => localStorage.setItem(LS_STORY_URL, UI.workerUrl.value.trim()));
  UI.ttsWorkerUrl && UI.ttsWorkerUrl.addEventListener("change", () => localStorage.setItem(LS_TTS_URL, UI.ttsWorkerUrl.value.trim()));
  UI.ttsVoice && UI.ttsVoice.addEventListener("change", () => localStorage.setItem(LS_TTS_VOICE, UI.ttsVoice.value));
  UI.narrationMode && UI.narrationMode.addEventListener("change", () => localStorage.setItem(LS_NARR_MODE, UI.narrationMode.value));
  UI.localVoice && UI.localVoice.addEventListener("change", () => { localStorage.setItem(LS_LOCAL_VOICE, UI.localVoice.value); pickLocalVoice(); });

  // Restore active campaign
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

  // Wire buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeMenu);

  UI.libraryBtn && (UI.libraryBtn.onclick = async () => { await stopAllAudio(); showSetup(); setStatus("Ready."); });
  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undo);

  UI.pauseBtn && (UI.pauseBtn.onclick = () => pauseResumeAudio());
  UI.stopBtn && (UI.stopBtn.onclick = async () => { await stopAllAudio(); setStatus("Ready."); });

  UI.continueBtn && (UI.continueBtn.onclick = continueStory);
  UI.wildBtn && (UI.wildBtn.onclick = doWildcard);

  // Service worker (your current sw.js is fine)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
