/* Neverending Story PWA (Local storage, worker-backed)
   app.js (clean) – fixes:
   - iOS voice priming (correct voice after user gesture)
   - Click SFX (click.mp3)
   - Pause/Resume/Stop
   - Choices ALWAYS clickable buttons
   - Story display never shows [STORY]/[CHOICES]/[MEMORY] or Memory Capsule
   - Library button wiring
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

  // support BOTH ids (your new HTML uses backToLibraryBtn)
  backToLibraryBtn: el("backToLibraryBtn") || el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  continueBtn: el("continueBtn"),

  // optional buttons you added in HTML
  pauseBtn: el("pauseBtn"),
  stopBtn: el("stopBtn"),

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
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = (ch === "x") ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

// ---------- UI ----------
function setStatus(msg) { if (UI.statusLine) UI.statusLine.textContent = msg; }
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
}

// ---------- Click SFX ----------
let CLICK = null;
try { CLICK = new Audio("click.mp3"); CLICK.preload = "auto"; } catch {}
function playClick() {
  try { if (!CLICK) return; CLICK.currentTime = 0; CLICK.play(); } catch {}
}

// ---------- iOS TTS priming + controls ----------
let voicesPrimed = false;
let preferredVoiceCache = null;

function primeVoices() {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v && v.length) { voicesPrimed = true; return resolve(v); }

    const handler = () => {
      const vv = speechSynthesis.getVoices();
      if (vv && vv.length) {
        voicesPrimed = true;
        speechSynthesis.onvoiceschanged = null;
        resolve(vv);
      }
    };
    speechSynthesis.onvoiceschanged = handler;
    setTimeout(handler, 50);
  });
}

function pickPreferredVoice() {
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const isCompact = (name) => (name || "").toLowerCase().includes("compact");

  // Prefer en-US non-compact
  const enUS = voices.find(v => (v.lang || "").toLowerCase() === "en-us" && !isCompact(v.name));
  if (enUS) return enUS;

  // Any English non-compact
  const en = voices.find(v => (v.lang || "").toLowerCase().startsWith("en") && !isCompact(v.name));
  if (en) return en;

  // any non-compact
  const nc = voices.find(v => !isCompact(v.name));
  if (nc) return nc;

  return voices[0] || null;
}

function stopNarration() {
  try { speechSynthesis.cancel(); } catch {}
  updateTransportUI();
}
function pauseNarration() {
  try { speechSynthesis.pause(); } catch {}
  updateTransportUI();
}
function resumeNarration() {
  try { speechSynthesis.resume(); } catch {}
  updateTransportUI();
}
function isSpeaking() { try { return !!speechSynthesis.speaking; } catch { return false; } }
function isPaused() { try { return !!speechSynthesis.paused; } catch { return false; } }

function updateTransportUI() {
  const pauseBtn = UI.pauseBtn;
  const stopBtn = UI.stopBtn;
  if (!pauseBtn || !stopBtn) return;

  const speaking = isSpeaking();
  const paused = isPaused();

  pauseBtn.disabled = !speaking && !paused;
  stopBtn.disabled = !speaking && !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
}

// Auto-stop on app switch / call / lock
window.addEventListener("pagehide", () => stopNarration());
document.addEventListener("visibilitychange", () => { if (document.hidden) stopNarration(); });

async function speakIfEnabled(c, text) {
  if (!c?.ttsOn) return;
  if (!("speechSynthesis" in window)) return;
  if (!text || !text.trim()) return;

  if (!voicesPrimed) await primeVoices();
  await new Promise(r => setTimeout(r, 50));

  try { speechSynthesis.cancel(); } catch {}

  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  if (!preferredVoiceCache) preferredVoiceCache = pickPreferredVoice();
  if (preferredVoiceCache) u.voice = preferredVoiceCache;

  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;

  u.onend = updateTransportUI;
  u.onerror = updateTransportUI;

  speechSynthesis.speak(u);
  updateTransportUI();
}

// ---------- Worker call ----------
async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error("Worker did not return JSON:\n" + raw.slice(0, 500)); }

  if (!res.ok) throw new Error(json?.error ? JSON.stringify(json) : ("Worker error: " + res.status));
  return json;
}

// ---------- Parsing (robust) ----------
function stripLabels(s) {
  if (!s) return "";
  return s
    .replace(/^\s*\[STORY\]\s*/i, "")
    .replace(/^\s*STORY:\s*/i, "")
    .trim();
}

function extractChoicesFromText(block) {
  if (!block) return [];
  const lines = block.split("\n").map(l => l.trim()).filter(Boolean);

  const choices = [];
  for (const line of lines) {
    const m = line.match(/^([1-4])[\)\.\-:]\s*(.+)$/);
    if (m) choices[parseInt(m[1], 10) - 1] = m[2].trim();
  }
  return choices.filter(Boolean);
}

function parseWorkerResponse(json) {
  // Structured worker
  if (json && (json.story_text || json.memory_capsule || Array.isArray(json.choices))) {
    return {
      storyText: stripLabels(json.story_text || ""),
      memoryCapsule: (json.memory_capsule || "").trim(),
      choices: Array.isArray(json.choices) ? json.choices : [],
    };
  }

  // Unstructured text field
  const raw = (json && (json.text || json.story_text)) ? (json.text || json.story_text) : "";
  if (!raw) return { storyText: "", memoryCapsule: "", choices: [] };

  // Preferred tagged format: [STORY]...[CHOICES]...[MEMORY]...
  const sTag = /\[STORY\]/i;
  const cTag = /\[CHOICES\]/i;
  const mTag = /\[MEMORY\]/i;

  const sIdx = raw.search(sTag);
  const cIdx = raw.search(cTag);
  const mIdx = raw.search(mTag);

  if (sIdx >= 0 && cIdx >= 0 && mIdx >= 0 && sIdx < cIdx && cIdx < mIdx) {
    const storyPart = raw.slice(sIdx, cIdx);
    const choicesPart = raw.slice(cIdx, mIdx);
    const memoryPart = raw.slice(mIdx);

    const storyText = stripLabels(storyPart.replace(/\[STORY\]/i, "").trim());
    const choicesText = choicesPart.replace(/\[CHOICES\]/i, "").trim();
    const memoryCapsule = memoryPart.replace(/\[MEMORY\]/i, "").trim();

    const choices = extractChoicesFromText(choicesText);

    return { storyText, memoryCapsule, choices };
  }

  // Legacy: [Memory Capsule] marker
  const legacyMarker = /\[Memory Capsule\]/i;
  const legacyIdx = raw.search(legacyMarker);

  let storyText = raw;
  let memoryCapsule = "";

  if (legacyIdx >= 0) {
    storyText = raw.slice(0, legacyIdx).trim();
    memoryCapsule = raw.slice(legacyIdx).replace(legacyMarker, "").trim();
  } else {
    // Also handle if the model accidentally included [MEMORY] without [CHOICES]
    const memIdx2 = raw.search(mTag);
    if (memIdx2 >= 0) {
      storyText = raw.slice(0, memIdx2).trim();
      memoryCapsule = raw.slice(memIdx2).replace(mTag, "").trim();
    }
  }

  // Pull choices from story tail (and remove them from display)
  const choices = extractChoicesFromText(storyText);
  if (choices.length) {
    storyText = storyText
      .split("\n")
      .filter(l => !/^([1-4])[\)\.\-:]\s*/.test(l.trim()))
      .join("\n")
      .trim();
  }

  return { storyText: stripLabels(storyText), memoryCapsule, choices };
}

// ---------- Memory format ----------
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

// ---------- Choices (ALWAYS clickable buttons) ----------
function renderChoices(c, choices) {
  UI.choices.innerHTML = "";

  if (!choices || choices.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No choices returned. Use “Something else” or Continue.";
    UI.choices.appendChild(p);
    return;
  }

  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${n}) ${label}`;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      playClick();
      if (!voicesPrimed) await primeVoices();
      await advanceWithChoice(c, n, label);
    });

    UI.choices.appendChild(btn);
  });
}

// ---------- Advance ----------
async function advanceWithChoice(c, choiceNumber, actionText) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;
  stopNarration();

  try {
    const updatedMemory = buildUpdatedMemory(c, choiceNumber, actionText);
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

    UI.storyText.textContent = c.lastStoryText;
    UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices);

    await speakIfEnabled(c, c.lastStoryText);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    UI.continueBtn.disabled = false;
  }
}

// ---------- Replay / Undo ----------
async function replay(c) {
  if (!c?.lastStoryText) return;
  stopNarration();
  if (!voicesPrimed) await primeVoices();
  await speakIfEnabled(c, c.lastStoryText);
}

function undo(c) {
  c.segments = c.segments || [];
  if (!c.segments.length) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.lastStoryText = last ? last.storyText : "";
  c.lastChoices = last ? last.choices : [];

  upsertCampaign(c);

  UI.storyText.textContent = c.lastStoryText || "";
  renderChoices(c, c.lastChoices || []);
  setStatus("Undid last step.");
}

// ---------- Start / Load / Wipe ----------
async function startNew() {
  const workerUrl = UI.workerUrl.value.trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const name = UI.campaignName.value.trim() || "Untitled Campaign";
  const seed = UI.seed.value.trim();
  if (!seed) return alert("Enter a seed.");

  const rating = UI.rating.value;
  const pacing = UI.pacing.value;
  const ttsOn = (UI.ttsMode.value === "on");

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
  UI.continueBtn.disabled = true;
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
      "Instruction: Start a new freeform solo story. Output EXACT format:",
      "[STORY] ...",
      "[CHOICES] 1..3 ...",
      "[MEMORY] ...",
      "Do NOT include memory inside the story text.",
    ].join("\n");

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

    UI.storyText.textContent = c.lastStoryText;
    UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices);

    await speakIfEnabled(c, c.lastStoryText);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    UI.continueBtn.disabled = false;
  }
}

function loadExisting() {
  const list = loadAll();
  if (!list.length) return alert("No local campaigns found.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);

  UI.storyText.textContent = c.lastStoryText || "";
  UI.memoryBox.textContent = c.memoryCapsule || "";
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
  // Wire transport buttons (if present in HTML)
  if (UI.pauseBtn) {
    UI.pauseBtn.addEventListener("click", () => {
      playClick();
      if (isPaused()) resumeNarration();
      else pauseNarration();
    });
  }
  if (UI.stopBtn) {
    UI.stopBtn.addEventListener("click", () => { playClick(); stopNarration(); });
  }

  // Restore last worker URL
  const last = loadAll()[0];
  if (last?.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    UI.storyText.textContent = c.lastStoryText || "";
    UI.memoryBox.textContent = c.memoryCapsule || "";
    renderChoices(c, c.lastChoices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  // Buttons
  UI.startBtn.addEventListener("click", async () => { playClick(); await startNew(); });
  UI.loadBtn.addEventListener("click", () => { playClick(); loadExisting(); });
  UI.wipeBtn.addEventListener("click", () => { playClick(); wipeAll(); });

  if (UI.backToLibraryBtn) {
    UI.backToLibraryBtn.addEventListener("click", () => {
      playClick();
      stopNarration();
      showSetup();
    });
  }

  UI.replayBtn.addEventListener("click", async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (c) await replay(c);
  });

  UI.undoBtn.addEventListener("click", () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (c) undo(c);
  });

  UI.continueBtn.addEventListener("click", async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (!c) return;
    if (!voicesPrimed) await primeVoices();
    await advanceWithChoice(c, 0, "Continue the scene without changing course.");
  });

  UI.wildBtn.addEventListener("click", async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    if (!voicesPrimed) await primeVoices();
    await advanceWithChoice(c, 0, t);
  });

  // Service worker (PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  updateTransportUI();
}

boot();
