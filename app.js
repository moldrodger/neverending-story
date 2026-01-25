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

  backToLibraryBtn: el("backToLibraryBtn") || el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  continueBtn: el("continueBtn"),

  pauseBtn: el("pauseBtn"),
  stopBtn: el("stopBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),
  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  memoryBox: el("memoryBox"),
};

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
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = (ch === "x") ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

function setStatus(msg) { UI.statusLine.textContent = msg; }
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

let CLICK = null;
try { CLICK = new Audio("click.mp3"); CLICK.preload = "auto"; } catch {}
function playClick() { try { if (!CLICK) return; CLICK.currentTime = 0; CLICK.play(); } catch {} }

// --- TTS (kept simple) ---
let voicesPrimed = false;
let preferredVoice = null;

function primeVoices() {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v && v.length) { voicesPrimed = true; return resolve(); }
    speechSynthesis.onvoiceschanged = () => { voicesPrimed = true; resolve(); };
    setTimeout(() => resolve(), 150);
  });
}
function pickVoice() {
  const voices = speechSynthesis.getVoices() || [];
  const isCompact = (n) => (n || "").toLowerCase().includes("compact");
  return (
    voices.find(v => (v.lang || "").toLowerCase() === "en-us" && !isCompact(v.name)) ||
    voices.find(v => (v.lang || "").toLowerCase().startsWith("en") && !isCompact(v.name)) ||
    voices.find(v => !isCompact(v.name)) ||
    voices[0] || null
  );
}
function stopNarration() { try { speechSynthesis.cancel(); } catch {} updateTransportUI(); }
function pauseNarration() { try { speechSynthesis.pause(); } catch {} updateTransportUI(); }
function resumeNarration() { try { speechSynthesis.resume(); } catch {} updateTransportUI(); }
function updateTransportUI() {
  if (!UI.pauseBtn || !UI.stopBtn) return;
  const speaking = !!speechSynthesis.speaking;
  const paused = !!speechSynthesis.paused;
  UI.pauseBtn.disabled = !speaking && !paused;
  UI.stopBtn.disabled = !speaking && !paused;
  UI.pauseBtn.textContent = paused ? "Resume" : "Pause";
}
async function speakIfEnabled(c, text) {
  if (!c.ttsOn) return;
  if (!("speechSynthesis" in window)) return;
  if (!text?.trim()) return;

  if (!voicesPrimed) await primeVoices();
  if (!preferredVoice) preferredVoice = pickVoice();

  stopNarration();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  if (preferredVoice) u.voice = preferredVoice;
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;
  u.onend = updateTransportUI;
  u.onerror = updateTransportUI;
  speechSynthesis.speak(u);
  updateTransportUI();
}

async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ? JSON.stringify(json) : `Worker error ${res.status}`);
  return json;
}

function renderStory(c) {
  UI.storyText.textContent = c.lastStoryText || "";
  UI.memoryBox.textContent = c.memoryCapsule || "";
}

function renderChoices(c) {
  UI.choices.innerHTML = "";

  const choices = Array.isArray(c.lastChoices) ? c.lastChoices : [];
  if (!choices.length) {
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
    btn.addEventListener("click", async () => {
      playClick();
      await advanceWithChoice(c, n, label);
    });
    UI.choices.appendChild(btn);
  });
}

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

async function advanceWithChoice(c, choiceNumber, actionText) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;
  stopNarration();

  try {
    const updatedMemory = buildUpdatedMemory(c, choiceNumber, actionText);

    const json = await callWorker(c.workerUrl, {
      choice: "CONTINUE",
      number: choiceNumber,
      memory: updatedMemory
    });

    // EXPECT STRUCTURED JSON FROM WORKER
    c.lastStoryText = (json.story_text || "").trim();
    c.lastChoices = Array.isArray(json.choices) ? json.choices : [];
    c.memoryCapsule = (json.memory_capsule || "").trim();

    c.segments = c.segments || [];
    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      choiceTaken: { number: choiceNumber, actionText },
    });

    upsertCampaign(c);
    renderStory(c);
    renderChoices(c);

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
      "Instruction: Start a new story in the EXACT format [STORY]/[CHOICES]/[MEMORY].",
    ].join("\n");

    const json = await callWorker(workerUrl, { choice: "START", number: 0, memory: startMemory });

    c.lastStoryText = (json.story_text || "").trim();
    c.lastChoices = Array.isArray(json.choices) ? json.choices : [];
    c.memoryCapsule = (json.memory_capsule || "").trim();

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      choiceTaken: { number: 0, actionText: "START" },
    });

    upsertCampaign(c);
    renderStory(c);
    renderChoices(c);

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
  renderStory(c);
  renderChoices(c);
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("This deletes ALL local campaigns on this device. Continue?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local data wiped.");
  showSetup();
}

function undo(c) {
  c.segments = c.segments || [];
  if (!c.segments.length) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];
  c.lastStoryText = last ? last.storyText : "";
  c.lastChoices = last ? last.choices : [];
  upsertCampaign(c);

  renderStory(c);
  renderChoices(c);
  setStatus("Undid last step.");
}

function boot() {
  if (UI.pauseBtn) UI.pauseBtn.addEventListener("click", () => {
    playClick();
    if (speechSynthesis.paused) resumeNarration();
    else pauseNarration();
  });
  if (UI.stopBtn) UI.stopBtn.addEventListener("click", () => { playClick(); stopNarration(); });

  const last = loadAll()[0];
  if (last?.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;
  if (c) {
    showPlay(c);
    renderStory(c);
    renderChoices(c);
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  UI.startBtn.addEventListener("click", async () => { playClick(); await startNew(); });
  UI.loadBtn.addEventListener("click", () => { playClick(); loadExisting(); });
  UI.wipeBtn.addEventListener("click", () => { playClick(); wipeAll(); });

  if (UI.backToLibraryBtn) UI.backToLibraryBtn.addEventListener("click", () => {
    playClick();
    stopNarration();
    showSetup();
  });

  UI.replayBtn.addEventListener("click", async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (c) await speakIfEnabled(c, c.lastStoryText);
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
    await advanceWithChoice(c, 0, "Continue naturally.");
  });

  UI.wildBtn.addEventListener("click", async () => {
    playClick();
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    await advanceWithChoice(c, 0, t);
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  updateTransportUI();
}

boot();
