/* Neverending Story PWA – v5
   - Story Worker: POST { action, memory } => { story_text, choices[], memory_capsule }
   - TTS Worker:  POST { text } => { audio_base64 } OR { audioUrl } (supports either)
   - Top-bar Narration toggle: persists per campaign
   - Replay/Pause/Stop control the REAL audio playback
*/

const LS_KEY = "nes_campaigns_v5";
const LS_ACTIVE = "nes_active_campaign_v5";
const LS_LAST_WORKER_URL = "nes_last_worker_url_v5";

// Your TTS worker URL:
const TTS_WORKER_URL = "https://nes-tts.292q4hbvh4.workers.dev/";

const el = (id) => document.getElementById(id);

const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
  seed: el("seed"),

  startBtn: el("startBtn"),
  loadBtn: el("loadBtn"),
  wipeBtn: el("wipeBtn"),

  libraryBtn: el("libraryBtn"),
  ttsToggleBtn: el("ttsToggleBtn"),
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
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAll(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
function upsertCampaign(c) {
  const list = loadAll();
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c;
  else list.unshift(c);
  saveAll(list);
}
function setActive(id) { localStorage.setItem(LS_ACTIVE, id); }
function getActiveId() { return localStorage.getItem(LS_ACTIVE); }
function findCampaign(id) { return loadAll().find(c => c.id === id) || null; }

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
  UI.memoryBox.textContent = c.memoryCapsule || "";
  updateTtsToggleLabel(c);
}
function setBusy(b) {
  if (UI.startBtn) UI.startBtn.disabled = b;
  if (UI.loadBtn) UI.loadBtn.disabled = b;
  if (UI.wipeBtn) UI.wipeBtn.disabled = b;
  if (UI.continueBtn) UI.continueBtn.disabled = b;
  if (UI.wildBtn) UI.wildBtn.disabled = b;

  const btns = UI.choices.querySelectorAll("button.choiceBtn");
  btns.forEach(x => x.disabled = b);
}

// ---------------- Audio engine ----------------
// We keep one shared audio element so Pause/Stop/Replay work reliably.
let audioEl = null;
let lastNarrationText = "";     // what we last narrated
let lastAudioSrc = "";          // last playable audio src (data URL or remote URL)

function ensureAudioEl() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.preload = "auto";
  audioEl.playsInline = true; // iOS
  // expose for debugging if needed
  window.__nesAudio = audioEl;
  return audioEl;
}

function stopAudio() {
  const a = ensureAudioEl();
  try { a.pause(); } catch {}
  try { a.currentTime = 0; } catch {}
}

function pauseAudio() {
  const a = ensureAudioEl();
  if (!a.src) return;
  if (!a.paused) a.pause();
  else a.play().catch(() => {});
}

function replayAudio() {
  const a = ensureAudioEl();
  if (!a.src && lastAudioSrc) a.src = lastAudioSrc;
  if (!a.src) return;
  try { a.currentTime = 0; } catch {}
  a.play().catch(() => {});
}

function updatePauseLabel() {
  if (!UI.pauseBtn) return;
  const a = ensureAudioEl();
  UI.pauseBtn.textContent = (a.src && !a.paused) ? "Pause" : "Resume";
}

// Call this after any play/pause/stop action
function syncTopButtons() {
  updatePauseLabel();
}

async function narrateIfEnabled(c, text) {
  if (!c?.ttsOn) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  // Save for replay even if TTS fails
  lastNarrationText = clean;

  setStatus("Narrating...");
  stopAudio();

  try {
    // Ask TTS worker for audio
    const res = await fetch(TTS_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ text: clean })
    });

    const payloadText = await res.text();
    let json;
    try { json = JSON.parse(payloadText); }
    catch { throw new Error("TTS worker returned non-JSON"); }

    if (!res.ok) throw new Error(json?.error || `TTS HTTP ${res.status}`);

    // Support either:
    //  - { audio_base64: "..." }
    //  - { audioUrl: "https://..." }
    const a = ensureAudioEl();

    if (json.audioUrl) {
      a.src = json.audioUrl;
      lastAudioSrc = json.audioUrl;
    } else if (json.audio_base64) {
      a.src = "data:audio/mpeg;base64," + json.audio_base64;
      lastAudioSrc = a.src;
    } else {
      throw new Error("TTS worker returned no audio");
    }

    // user gesture is the click on Start/Choice button, so iOS should allow play
    await a.play();
    syncTopButtons();
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Ready (no audio).");
  }
}

// ---------------- Story worker call + parsing ----------------
async function callStoryWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); }
  catch { throw new Error("Story worker returned non-JSON. Raw:\n" + txt.slice(0, 300)); }

  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  if (json?.error) throw new Error(String(json.error));

  return json;
}

function normalizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3);
}

function parseStoryResponse(json) {
  // Expected structured
  if (json && (json.story_text || json.memory_capsule || Array.isArray(json.choices))) {
    return {
      story: String(json.story_text || "").trim(),
      choices: normalizeChoices(json.choices),
      memory: String(json.memory_capsule || "").trim(),
    };
  }

  // Fallback: tagged blob inside json.text
  const raw = String(json?.text || "").trim();
  const storyMatch = raw.match(/\[STORY\]([\s\S]*?)(?=\[CHOICES\]|\[MEMORY\]|$)/i);
  const choicesMatch = raw.match(/\[CHOICES\]([\s\S]*?)(?=\[MEMORY\]|$)/i);
  const memoryMatch = raw.match(/\[MEMORY\]([\s\S]*?)$/i);

  const story = String(storyMatch?.[1] || raw).trim();
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

  return { story, choices: choices.filter(Boolean).slice(0, 3), memory };
}

// ---------------- Memory builders ----------------
function buildStartMemory(seed, rating, pacing) {
  return [
    "[Story Seed]",
    seed,
    "",
    "[Settings]",
    `rating=${rating}`,
    `pacing=${pacing}`,
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

// ---------------- Rendering ----------------
function renderStoryText(text) {
  UI.storyText.textContent = String(text || "").trim();
}

function renderChoices(c, choices) {
  UI.choices.innerHTML = "";

  if (!choices || choices.length === 0) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices returned. Use Something else or Continue.";
    UI.choices.appendChild(d);
    return;
  }

  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advance(c, n, label);
    UI.choices.appendChild(btn);
  });
}

// ---------------- Narration Toggle ----------------
function updateTtsToggleLabel(c) {
  if (!UI.ttsToggleBtn) return;
  UI.ttsToggleBtn.textContent = c?.ttsOn ? "Narration: On" : "Narration: Off";
}

function setTtsOn(c, on) {
  c.ttsOn = !!on;
  upsertCampaign(c);
  updateTtsToggleLabel(c);

  if (!c.ttsOn) {
    stopAudio();
    setStatus("Ready.");
  } else {
    // Optional: immediately narrate current story when turning on
    if (c.story) narrateIfEnabled(c, c.story);
  }
}

// ---------------- Main actions ----------------
async function startNew() {
  const workerUrl = (UI.workerUrl.value || "").trim();
  if (!workerUrl) return alert("Enter your Story Worker URL.");

  // save so you don’t need to retype
  localStorage.setItem(LS_LAST_WORKER_URL, workerUrl);

  const name = (UI.campaignName.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const rating = (UI.rating.value || "PG-13").trim();
  const pacing = (UI.pacing.value || "long").trim();

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating,
    pacing,

    // default narration OFF (you can flip default to true if you want)
    ttsOn: false,

    story: "",
    choices: [],
    memoryCapsule: "",
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  setBusy(true);
  setStatus("Starting story...");
  stopAudio();

  try {
    const memory = buildStartMemory(seed, rating, pacing);
    const json = await callStoryWorker(workerUrl, { action: "Begin the story.", memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.story;
    c.choices = parsed.choices;
    c.memoryCapsule = parsed.memory;

    c.segments = [{ at: Date.now(), story: c.story, choices: c.choices }];

    upsertCampaign(c);

    renderStoryText(c.story);
    renderChoices(c, c.choices);
    UI.memoryBox.textContent = c.memoryCapsule || "";

    // Auto-narrate only if toggle is ON
    await narrateIfEnabled(c, c.story);

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
  stopAudio();

  try {
    const memory = buildNextMemory(c, `choice_${choiceNumber}: ${actionText}`);
    const json = await callStoryWorker(c.workerUrl, { action: actionText, memory });
    const parsed = parseStoryResponse(json);

    c.story = parsed.story;
    c.choices = parsed.choices;
    c.memoryCapsule = parsed.memory || c.memoryCapsule;

    c.segments = c.segments || [];
    c.segments.push({ at: Date.now(), story: c.story, choices: c.choices });

    upsertCampaign(c);

    renderStoryText(c.story);
    renderChoices(c, c.choices);
    UI.memoryBox.textContent = c.memoryCapsule || "";

    await narrateIfEnabled(c, c.story);

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
  // If we have audio loaded, replay it.
  const a = ensureAudioEl();
  if (a.src) {
    replayAudio();
    syncTopButtons();
    return;
  }

  // Otherwise re-generate narration from last text (if narration enabled)
  const c = findCampaign(getActiveId());
  if (!c) return;
  if (!c.ttsOn) return;

  narrateIfEnabled(c, c.story || lastNarrationText || "");
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

  renderStoryText(c.story);
  renderChoices(c, c.choices);

  stopAudio();
  setStatus("Undid last step.");
}

function continueStory() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  advance(c, 0, "Continue.");
}

function doWildcard() {
  const c = findCampaign(getActiveId());
  if (!c) return;
  const t = (UI.wildInput.value || "").trim();
  if (!t) return alert("Type your action first.");
  UI.wildInput.value = "";
  advance(c, 0, t);
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

  renderStoryText(c.story || "");
  renderChoices(c, c.choices || []);
  UI.memoryBox.textContent = c.memoryCapsule || "";

  stopAudio();
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("Delete ALL campaigns stored on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  showSetup();
  stopAudio();
  alert("Local campaigns wiped.");
}

// ---------------- Boot ----------------
function boot() {
  // Prefill worker URL from last used
  const lastUrl = localStorage.getItem(LS_LAST_WORKER_URL);
  if (lastUrl && UI.workerUrl) UI.workerUrl.value = lastUrl;

  // Restore active campaign
  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStoryText(c.story || "");
    renderChoices(c, c.choices || []);
    UI.memoryBox.textContent = c.memoryCapsule || "";
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
    stopAudio();
    showSetup();
    setStatus("Ready.");
  };

  UI.ttsToggleBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    // If no campaign loaded yet, just toggle the label won’t matter
    if (!c) {
      alert("Start or load a campaign first.");
      return;
    }
    setTtsOn(c, !c.ttsOn);
  };

  UI.replayBtn.onclick = () => { replay(); };

  UI.pauseBtn.onclick = () => {
    pauseAudio();
    syncTopButtons();
  };

  UI.stopBtn.onclick = () => {
    stopAudio();
    syncTopButtons();
  };

  UI.undoBtn.onclick = undo;

  UI.continueBtn.onclick = continueStory;
  UI.wildBtn.onclick = doWildcard;

  // Service worker (PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Keep pause label correct if audio ends
  const a = ensureAudioEl();
  a.addEventListener("ended", () => syncTopButtons());
  a.addEventListener("pause", () => syncTopButtons());
  a.addEventListener("play", () => syncTopButtons());
}

boot();
