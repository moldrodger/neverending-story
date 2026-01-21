/* Neverending Story PWA (Local storage, worker-backed)
   CLEAN DROP-IN app.js (iOS voice priming + click SFX + Pause/Resume/Stop + no duplicate choices)

   Requirements:
   - Your index.html must already have the same element IDs you were using:
     setupCard, playCard, campaignPill,
     workerUrl, campaignName, rating, pacing, ttsMode, seed,
     startBtn, loadBtn, wipeBtn,
     backToLibraryBtn, replayBtn, undoBtn, continueBtn,
     statusLine, storyText, choices, wildInput, wildBtn, memoryBox
   - Optional: put a file named click.mp3 in the same folder as index.html/app.js.
*/

const LS_KEY = "nes_campaigns_v1";
const LS_ACTIVE = "nes_active_campaign_v1";

const el = (id) => document.getElementById(id);

const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  campaignPill: el("campaignPill"),

  workerUrl: el("workerUrl"),
  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
  ttsMode: el("ttsMode"),
  seed: el("seed"),

  startBtn: el("startBtn"),
  loadBtn: el("loadBtn"),
  wipeBtn: el("wipeBtn"),

  backToLibraryBtn: el("backToLibraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  continueBtn: el("continueBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),
  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  memoryBox: el("memoryBox"),
};

// ---------- Local storage helpers ----------
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
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c; else list.unshift(c);
  saveAll(list);
}
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = (ch === "x") ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

// ---------- UI helpers ----------
function setStatus(msg) {
  if (UI.statusLine) UI.statusLine.textContent = msg;
}
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

// ---------- Click SFX ----------
let CLICK = null;
try {
  CLICK = new Audio("click.mp3");
  CLICK.preload = "auto";
} catch {}
function playClick() {
  try {
    if (!CLICK) return;
    CLICK.currentTime = 0;
    // iOS requires user gesture (we only call this from button taps)
    CLICK.play();
  } catch {}
}

// ---------- iOS TTS voice priming + transport controls ----------
let voicesPrimed = false;
let preferredVoiceCache = null;

function primeVoices() {
  // Must be called after a user gesture on iOS for reliable voice selection.
  return new Promise((resolve) => {
    const v = window.speechSynthesis?.getVoices?.() || [];
    if (v.length) {
      voicesPrimed = true;
      resolve(v);
      return;
    }
    // Wait for voiceschanged
    const handler = () => {
      const vv = window.speechSynthesis?.getVoices?.() || [];
      if (vv.length) {
        voicesPrimed = true;
        window.speechSynthesis.onvoiceschanged = null;
        resolve(vv);
      }
    };
    window.speechSynthesis.onvoiceschanged = handler;
    // Some iOS builds require a second tick
    setTimeout(handler, 50);
  });
}

function pickPreferredVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;

  // Prefer en-US, then any English, avoid Compact voices.
  const isCompact = (name) => (name || "").toLowerCase().includes("compact");

  const enUS = voices.filter(v => (v.lang || "").toLowerCase() === "en-us" && !isCompact(v.name));
  if (enUS.length) return enUS[0];

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en") && !isCompact(v.name));
  if (en.length) return en[0];

  // Fallback: first non-compact voice of any language (better than compact)
  const nonCompact = voices.filter(v => !isCompact(v.name));
  if (nonCompact.length) return nonCompact[0];

  return voices[0] || null;
}

function stopNarration() {
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch {}
  updateTransportUI();
}

function pauseNarration() {
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.pause();
  } catch {}
  updateTransportUI();
}

function resumeNarration() {
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.resume();
  } catch {}
  updateTransportUI();
}

function isSpeaking() {
  try { return !!window.speechSynthesis?.speaking; } catch { return false; }
}
function isPaused() {
  try { return !!window.speechSynthesis?.paused; } catch { return false; }
}

// Create Pause/Stop buttons if your HTML doesn't have them
let pauseBtn = null;
let stopBtn = null;

function ensureTransportButtons() {
  if (!UI.replayBtn) return;

  const container = UI.replayBtn.parentElement || UI.replayBtn;

  if (!pauseBtn) {
    pauseBtn = document.createElement("button");
    pauseBtn.id = "pauseBtn";
    pauseBtn.type = "button";
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = () => {
      playClick();
      if (isPaused()) resumeNarration();
      else pauseNarration();
    };
    container.appendChild(pauseBtn);
  }

  if (!stopBtn) {
    stopBtn = document.createElement("button");
    stopBtn.id = "stopBtn";
    stopBtn.type = "button";
    stopBtn.textContent = "Stop";
    stopBtn.onclick = () => {
      playClick();
      stopNarration();
    };
    container.appendChild(stopBtn);
  }

  updateTransportUI();
}

function updateTransportUI() {
  if (!pauseBtn || !stopBtn) return;
  const speaking = isSpeaking();
  const paused = isPaused();

  pauseBtn.disabled = !speaking && !paused;
  stopBtn.disabled = !speaking && !paused;

  pauseBtn.textContent = paused ? "Resume" : "Pause";
}

// Auto-stop when app loses focus (phone call / app switch / lock screen)
window.addEventListener("pagehide", () => stopNarration());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopNarration();
});

// ---------- Speak ----------
async function speakIfEnabled(c, text) {
  if (!c?.ttsOn) return;
  if (!("speechSynthesis" in window)) return;
  if (!text || !text.trim()) return;

  // iOS: voices often unavailable until after user gesture; prime them.
  if (!voicesPrimed) await primeVoices();

  // Small delay helps iOS settle voice selection
  await new Promise(r => setTimeout(r, 50));

  try { window.speechSynthesis.cancel(); } catch {}

  const u = new SpeechSynthesisUtterance(text);

  // Force English narration
  u.lang = "en-US";

  // Cache a preferred voice once voices exist
  if (!preferredVoiceCache) preferredVoiceCache = pickPreferredVoice();
  if (preferredVoiceCache) u.voice = preferredVoiceCache;

  // More audiobook-ish pacing
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;

  u.onend = updateTransportUI;
  u.onerror = updateTransportUI;

  try {
    window.speechSynthesis.speak(u);
  } catch {}

  updateTransportUI();
}

// ---------- Worker parsing ----------
function parseChoicesFromLines(lines) {
  const extracted = [];
  for (const line of lines) {
    const m = line.match(/^([1-4])[\)\.\-:]\s*(.+)$/);
    if (m) extracted[parseInt(m[1], 10) - 1] = m[2].trim();
  }
  return extracted.filter(Boolean);
}

function parseWorkerResponse(json) {
  // Case B: already structured
  if (json && (json.story_text || json.memory_capsule || Array.isArray(json.choices))) {
    return {
      storyText: json.story_text || "",
      memoryCapsule: json.memory_capsule || "",
      choices: Array.isArray(json.choices) ? json.choices : [],
    };
  }

  // Case A/C: worker returns { text: "..."} with markers
  const raw = (json && (json.text || json.story_text)) ? (json.text || json.story_text) : "";
  if (!raw) return { storyText: "", memoryCapsule: "", choices: [] };

  // Preferred format:
  // [STORY] ... [CHOICES] ... [MEMORY] ...
  const storyTag = "[STORY]";
  const choicesTag = "[CHOICES]";
  const memTag = "[MEMORY]";

  const sIdx = raw.indexOf(storyTag);
  const cIdx = raw.indexOf(choicesTag);
  const mIdx = raw.indexOf(memTag);

  if (sIdx >= 0 && cIdx >= 0 && mIdx >= 0) {
    const storyText = raw.slice(sIdx + storyTag.length, cIdx).trim();
    const choicesBlock = raw.slice(cIdx + choicesTag.length, mIdx).trim();
    const memPart = raw.slice(mIdx + memTag.length).trim();

    const choicesLines = choicesBlock.split("\n").map(l => l.trim()).filter(Boolean);
    const choices = parseChoicesFromLines(choicesLines);

    return { storyText, memoryCapsule: memPart, choices };
  }

  // Legacy marker format: [Memory Capsule]
  const marker = "[Memory Capsule]";
  const idx = raw.indexOf(marker);
  let storyPart = raw;
  let memPart = "";
  if (idx >= 0) {
    storyPart = raw.slice(0, idx).trim();
    memPart = raw.slice(idx + marker.length).trim();
  }

  // If the model included choices at the bottom of storyPart, extract them then REMOVE from story display.
  const lines = storyPart.split("\n").map(l => l.trim());
  const choices = parseChoicesFromLines(lines);

  let cleanedStory = storyPart;
  if (choices.length) {
    // Remove trailing choice lines (best-effort)
    const cleanedLines = [];
    for (const line of lines) {
      if (/^([1-4])[\)\.\-:]\s*/.test(line)) continue;
      cleanedLines.push(line);
    }
    cleanedStory = cleanedLines.join("\n").trim();
  }

  return {
    storyText: cleanedStory,
    memoryCapsule: memPart,
    choices,
  };
}

// ---------- Worker call ----------
async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error("Worker did not return JSON. Raw:\n" + text.slice(0, 500));
  }

  if (!res.ok) {
    throw new Error((json && json.error) ? JSON.stringify(json) : "Worker error: " + res.status);
  }

  return json;
}

// ---------- Memory format (kept compatible with your worker) ----------
function buildUpdatedMemory(c, choiceNumber, actionText) {
  const cap = c.memoryCapsule || "";
  return [
    cap ? "[Memory Capsule]\n" + cap : "[Memory Capsule]\n",
    "",
    "[Player Choice]",
    `number=${choiceNumber}`,
    `action=${actionText}`,
  ].join("\n");
}

// ---------- Choice rendering ----------
function renderChoices(c, choices) {
  if (!UI.choices) return;
  UI.choices.innerHTML = "";

  if (!choices || choices.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No choices detected. You can use “Something else” below.";
    UI.choices.appendChild(p);
    return;
  }

  // Only show first 3 as buttons. “Something else” is handled by the text box.
  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = async () => {
      playClick();
      // Prime voices on first real user gesture (iOS)
      if (!voicesPrimed) await primeVoices();
      await advanceWithChoice(c, n, label);
    };
    UI.choices.appendChild(btn);
  });
}

// ---------- Advance ----------
async function advanceWithChoice(c, choiceNumber, actionText) {
  setStatus("Generating next segment...");
  if (UI.continueBtn) UI.continueBtn.disabled = true;

  // Stop any current narration so the new one is clear
  stopNarration();

  try {
    const updatedMemory = buildUpdatedMemory(c, choiceNumber, actionText);

    // For your worker: keep this payload shape:
    // { choice: "CONTINUE", number: <n>, memory: <updatedMemory> }
    const payload = { choice: "CONTINUE", number: choiceNumber, memory: updatedMemory };

    const json = await callWorker(c.workerUrl, payload);
    const parsed = parseWorkerResponse(json);

    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule;
    c.lastStoryText = parsed.storyText || "";
    c.lastChoices = parsed.choices || [];
    c.segments = c.segments || [];

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      choiceTaken: { number: choiceNumber, actionText },
    });

    upsertCampaign(c);

    if (UI.storyText) UI.storyText.textContent = c.lastStoryText;
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices);

    // Speak only from user-gesture paths
    await speakIfEnabled(c, c.lastStoryText);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    if (UI.continueBtn) UI.continueBtn.disabled = false;
  }
}

// ---------- Replay / Undo ----------
async function replay(c) {
  if (!c?.lastStoryText) return;
  stopNarration();
  // Prime voices if needed (must be called from button tap)
  if (!voicesPrimed) await primeVoices();
  await speakIfEnabled(c, c.lastStoryText);
}

function undo(c) {
  c.segments = c.segments || [];
  if (c.segments.length === 0) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  if (last) {
    c.lastStoryText = last.storyText;
    c.lastChoices = last.choices;
    c.memoryCapsule = c.memoryCapsule; // keep current capsule (or you can store per segment if desired)
  } else {
    c.lastStoryText = "";
    c.lastChoices = [];
  }

  upsertCampaign(c);
  if (UI.storyText) UI.storyText.textContent = c.lastStoryText || "";
  renderChoices(c, c.lastChoices || []);
  setStatus("Undid last step.");
}

// ---------- Start / Load / Wipe ----------
async function startNew() {
  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a seed.");

  const rating = UI.rating?.value || "PG-13";
  const pacing = UI.pacing?.value || "long";
  const ttsOn = (UI.ttsMode?.value === "on");

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating,
    pacing,
    ttsOn,
    memoryCapsule: "",
    lastStoryText: "",
    lastChoices: [],
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  setStatus("Starting story...");
  if (UI.continueBtn) UI.continueBtn.disabled = true;

  // Stop any current narration
  stopNarration();

  try {
    const startMemory = [
      "[Story Seed]",
      seed,
      "",
      "[Settings]",
      `rating=${rating}`,
      `pacing=${pacing}`,
      "",
      "Instruction: Start a new freeform solo story. Provide a story segment, then 3 numbered choices (1-3) plus a 'Something else' option. Include a [MEMORY] section at the end. Do NOT repeat the choices inside the story text; keep choices only under [CHOICES].",
    ].join("\n");

    // Prime voices on the Start button tap so iOS will use the correct installed voice
    if (!voicesPrimed) await primeVoices();

    const json = await callWorker(workerUrl, { choice: "START", number: 0, memory: startMemory });
    const parsed = parseWorkerResponse(json);

    c.memoryCapsule = parsed.memoryCapsule || "";
    c.lastStoryText = parsed.storyText || "";
    c.lastChoices = parsed.choices || [];

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      choiceTaken: { number: 0, actionText: "START" },
    });

    upsertCampaign(c);

    if (UI.storyText) UI.storyText.textContent = c.lastStoryText;
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices);

    await speakIfEnabled(c, c.lastStoryText);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    if (UI.continueBtn) UI.continueBtn.disabled = false;
  }
}

function loadExisting() {
  const list = loadAll();
  if (list.length === 0) return alert("No local campaigns found.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);

  if (UI.storyText) UI.storyText.textContent = c.lastStoryText || "";
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
  renderChoices(c, c.lastChoices || []);
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("This deletes ALL local campaigns on this device. Continue?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local data wiped.");
  showSetup();
}

// ---------- Boot ----------
function boot() {
  ensureTransportButtons();

  // Restore last used worker URL if any
  const last = loadAll()[0];
  if (last?.workerUrl && UI.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;
  if (c) {
    showPlay(c);
    if (UI.storyText) UI.storyText.textContent = c.lastStoryText || "";
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  // Buttons
  if (UI.startBtn) UI.startBtn.onclick = async () => { playClick(); await startNew(); };
  if (UI.loadBtn) UI.loadBtn.onclick = () => { playClick(); loadExisting(); };
  if (UI.wipeBtn) UI.wipeBtn.onclick = () => { playClick(); wipeAll(); };

  if (UI.backToLibraryBtn) UI.backToLibraryBtn.onclick = () => { playClick(); stopNarration(); showSetup(); };

  if (UI.replayBtn) UI.replayBtn.onclick = async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (c) await replay(c);
  };

  if (UI.undoBtn) UI.undoBtn.onclick = () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (c) undo(c);
  };

  if (UI.continueBtn) UI.continueBtn.onclick = async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (!c) return;
    if (!voicesPrimed) await primeVoices();
    // Continue without changing course
    await advanceWithChoice(c, 0, "Continue the scene without changing course.");
  };

  if (UI.wildBtn) UI.wildBtn.onclick = async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = (UI.wildInput?.value || "").trim();
    if (!t) return alert("Type your action first.");
    if (UI.wildInput) UI.wildInput.value = "";
    if (!voicesPrimed) await primeVoices();
    await advanceWithChoice(c, 0, t);
  };

  // Register service worker (PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
