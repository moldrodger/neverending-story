/* Neverending Story – app.js (Branching segments + stable narration)
   - Multiple campaigns supported (library)
   - Each campaign has numbered segments (1..N)
   - Jump back to a segment: everything after it is removed if you change the path
   - If you follow the same path, it reuses saved segments (no worker call)

   Story Worker: POST { action, memory } -> { story_text, choices[], memory_capsule }
   TTS Worker:   POST { text, voice }   -> { audio_base64 }
   OpenAI TTS playback: <audio> + Blob URL
*/

const LS_KEY = "nes_campaigns_v8";
const LS_ACTIVE = "nes_active_campaign_v8";

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
function deleteCampaignById(id) {
  const list = loadAll();
  saveAll(list.filter(c => c.id !== id));
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
  UI.campaignPill && (UI.campaignPill.textContent = c.name || "Untitled");
  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
}

function setBusy(b) {
  [UI.startBtn, UI.loadBtn, UI.wipeBtn, UI.continueBtn, UI.wildBtn].forEach(x => { if (x) x.disabled = b; });
  (UI.choices?.querySelectorAll?.("button.choiceBtn") || []).forEach(btn => btn.disabled = b);
  if (UI.replayBtn) UI.replayBtn.disabled = b;
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

// ---------------- OpenAI TTS via <audio> Blob ----------------
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
  catch { throw new Error("TTS worker returned non-JSON."); }

  if (!res.ok) throw new Error(json?.error || `TTS HTTP ${res.status}`);
  if (my !== ttsToken) return;

  const b64 = json.audio_base64;
  if (!b64) throw new Error("TTS worker returned no audio_base64.");

  setStatus("Narrating… (playing audio)");

  cleanupBlobUrl();
  currentBlobUrl = base64ToBlobUrl(b64, "audio/mpeg");
  audioEl.src = currentBlobUrl;

  const p = audioEl.play();
  if (p && typeof p.then === "function") await p;

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

  localStop();
  stopOpenAITTS();

  if (mode === "local") {
    setStatus("Narrating… (local)");
    localSpeak(clean);
    // Don't instantly overwrite status; iOS speech is async.
    // Keep it simple:
    setTimeout(() => setStatus("Ready."), 200);
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

// ---------------- Segments helpers (NEW) ----------------
function ensureCampaignShape(c) {
  // segments: array of saved timeline steps
  if (!Array.isArray(c.segments)) c.segments = [];
  if (typeof c.cursor !== "number") c.cursor = c.segments.length ? (c.segments.length - 1) : 0;
  if (c.cursor < 0) c.cursor = 0;
  if (c.cursor > c.segments.length - 1) c.cursor = Math.max(0, c.segments.length - 1);
  return c;
}

function applySegmentToCampaign(c, segIdx) {
  ensureCampaignShape(c);
  if (!c.segments.length) return;

  const idx = Math.max(0, Math.min(segIdx, c.segments.length - 1));
  const seg = c.segments[idx];
  c.cursor = idx;

  c.story = seg.story || "";
  c.choices = seg.choices || [];
  c.memoryCapsule = seg.memoryCapsule || "";

  upsertCampaign(c);

  UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
  renderStory(c.story);
  renderChoices(c, c.choices);

  setStatus(`Ready. (Segment ${c.cursor + 1}/${c.segments.length})`);
}

function truncateAfterCursor(c) {
  ensureCampaignShape(c);
  if (!c.segments.length) return;
  c.segments = c.segments.slice(0, c.cursor + 1);
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

  const c = ensureCampaignShape({
    id: uuid(),
    name,
    workerUrl: storyUrl,
    rating,
    pacing,
    story: "",
    choices: [],
    memoryCapsule: "",
    segments: [],
    cursor: 0,
  });

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  setBusy(true);
  setStatus("Starting...");
  try {
    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callStoryWorker(storyUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    // Segment 1 (root)
    const seg0 = {
      at: Date.now(),
      story: parsed.storyText || "",
      choices: parsed.choices || [],
      memoryCapsule: parsed.memoryCapsule || "",
      fromAction: null,
      fromChoiceNumber: null,
    };

    c.segments = [seg0];
    c.cursor = 0;

    c.story = seg0.story;
    c.choices = seg0.choices;
    c.memoryCapsule = seg0.memoryCapsule;

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    setStatus(`Ready. (Segment 1/1)`);
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

async function advance(c, choiceNumber, actionText) {
  c = ensureCampaignShape(findCampaign(c.id) || c);

  // If we are not at the end, and user picked the SAME path as saved,
  // just move forward to the already-saved next segment.
  const nextIdx = c.cursor + 1;
  if (nextIdx < c.segments.length) {
    const nextSeg = c.segments[nextIdx];
    if (nextSeg && nextSeg.fromAction === actionText) {
      applySegmentToCampaign(c, nextIdx);
      return;
    }
    // Different choice than saved timeline -> truncate future
    truncateAfterCursor(c);
    upsertCampaign(c);
  }

  setBusy(true);
  setStatus("Generating...");
  try {
    localStop();
    stopOpenAITTS();

    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    const newSeg = {
      at: Date.now(),
      story: parsed.storyText || "",
      choices: parsed.choices || [],
      memoryCapsule: parsed.memoryCapsule || c.memoryCapsule || "",
      fromAction: actionText,
      fromChoiceNumber: choiceNumber,
    };

    c.segments.push(newSeg);
    c.cursor = c.segments.length - 1;

    c.story = newSeg.story;
    c.choices = newSeg.choices;
    c.memoryCapsule = newSeg.memoryCapsule;

    upsertCampaign(c);

    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule);
    renderStory(c.story);
    renderChoices(c, c.choices);

    setStatus(`Ready. (Segment ${c.cursor + 1}/${c.segments.length})`);
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

function replay() {
  const c = ensureCampaignShape(findCampaign(getActiveId()));
  if (!c) return;
  narrate(c.story || "");
}

function undoOrJump() {
  const c0 = findCampaign(getActiveId());
  if (!c0) return;
  const c = ensureCampaignShape(c0);

  if (!c.segments.length) return;

  const hint =
`Undo / Jump to Segment
- Enter a segment number (1..${c.segments.length}) to jump there.
- Leave blank (or Cancel) to step back ONE segment.`;

  const pick = prompt(hint, "");
  if (pick === null || String(pick).trim() === "") {
    // Normal undo (step back one)
    if (c.cursor <= 0) return;
    applySegmentToCampaign(c, c.cursor - 1);
    return;
  }

  const n = parseInt(String(pick).trim(), 10);
  if (!n || n < 1 || n > c.segments.length) {
    alert("Invalid segment number.");
    return;
  }

  // Jump to segment N, and TRUNCATE everything after it (because you’re rewinding time)
  c.cursor = n - 1;
  truncateAfterCursor(c);
  upsertCampaign(c);
  applySegmentToCampaign(c, c.cursor);
}

function loadExisting() {
  const list = loadAll();
  if (!list.length) return alert("No saved campaigns on this device.");

  const names = list.map((c, i) => `${i + 1}) ${c.name} (${(c.segments?.length || 0)} segs)`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = ensureCampaignShape(list[n - 1]);
  setActive(c.id);
  showPlay(c);

  // Load current cursor segment
  if (c.segments.length) {
    applySegmentToCampaign(c, c.cursor);
  } else {
    renderStory(c.story || "");
    renderChoices(c, c.choices || []);
    UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
    setStatus("Loaded.");
  }
}

function wipeMenu() {
  const list = loadAll();
  if (!list.length) return alert("No saved campaigns on this device.");

  const activeId = getActiveId();
  const active = activeId ? findCampaign(activeId) : null;

  const menu =
`Wipe options:

1) Wipe ENTIRE library (delete all stories)
2) Delete CURRENT story ${active ? `("${active.name}")` : "(none active)"}
3) Wipe CHAPTERS in current story (clear all segments, keep story entry)
4) Delete a SPECIFIC story (pick from list)
5) Cancel`;

  const pick = prompt(menu, "5");
  const n = parseInt((pick || "").trim(), 10);
  if (!n || n === 5) return;

  localStop();
  stopOpenAITTS();

  if (n === 1) {
    if (!confirm("Delete ALL campaigns stored on this device?")) return;
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_ACTIVE);
    showSetup();
    alert("Local library wiped.");
    return;
  }

  if (n === 2) {
    if (!active) return alert("No active story selected.");
    if (!confirm(`Delete current story "${active.name}"?`)) return;
    deleteCampaignById(active.id);
    showSetup();
    setStatus("Ready.");
    alert("Current story deleted.");
    return;
  }

  if (n === 3) {
    if (!active) return alert("No active story selected.");
    if (!confirm(`Wipe chapters/segments for "${active.name}"? (Keeps the story entry)`)) return;

    const c = ensureCampaignShape(active);
    c.segments = [];
    c.cursor = 0;
    c.story = "";
    c.choices = [];
    c.memoryCapsule = "";
    upsertCampaign(c);

    showPlay(c);
    UI.memoryBox && (UI.memoryBox.textContent = "");
    UI.storyText && (UI.storyText.textContent = "");
    if (UI.choices) UI.choices.innerHTML = "";

    setStatus("Ready.");
    alert("Chapters/segments cleared.");
    return;
  }

  if (n === 4) {
    const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
    const which = prompt("Pick a story number to delete:\n\n" + names);
    const idx = parseInt((which || "").trim(), 10);
    if (!idx || idx < 1 || idx > list.length) return;

    const target = list[idx - 1];
    if (!confirm(`Delete "${target.name}"?`)) return;

    deleteCampaignById(target.id);

    if (activeId === target.id) {
      showSetup();
      setStatus("Ready.");
    }

    alert("Story deleted.");
    return;
  }

  alert("Unknown option.");
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
  const c0 = activeId ? findCampaign(activeId) : null;

  if (c0) {
    const c = ensureCampaignShape(c0);
    showPlay(c);

    if (c.segments.length) {
      applySegmentToCampaign(c, c.cursor);
    } else {
      UI.memoryBox && (UI.memoryBox.textContent = c.memoryCapsule || "");
      renderStory(c.story || "");
      renderChoices(c, c.choices || []);
      setStatus("Loaded.");
    }
  } else {
    showSetup();
    setStatus("Ready.");
  }

  // wire buttons
  UI.startBtn && (UI.startBtn.onclick = startNew);
  UI.loadBtn && (UI.loadBtn.onclick = loadExisting);
  UI.wipeBtn && (UI.wipeBtn.onclick = wipeMenu);

  UI.libraryBtn && (UI.libraryBtn.onclick = () => {
    localStop();
    stopOpenAITTS();
    showSetup();
    setStatus("Ready.");
  });

  UI.replayBtn && (UI.replayBtn.onclick = replay);
  UI.undoBtn && (UI.undoBtn.onclick = undoOrJump);

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
