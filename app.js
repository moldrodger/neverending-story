/* Neverending Story PWA (local storage + Cloudflare worker)
   - iOS-friendly TTS autostart via "speech unlock" on user gesture
   - Best-available English voice selection for Web Speech
   - Worker response supported:
       A) { story_text, choices[], memory_capsule }
       B) { text: "[STORY]..[CHOICES]..[MEMORY].." } (tagged text)
   - Story area shows ONLY story text (no choices, no memory)
   - Choice buttons are selectable (1-3)
   - Memory capsule hidden except Debug panel
*/

const LS_KEY = "nes_campaigns_v3";
const LS_ACTIVE = "nes_active_campaign_v3";

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

  libraryBtn: el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  pauseBtn: el("pauseBtn"),
  stopBtn: el("stopBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),

  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"),
};

// ----------------- Storage helpers -----------------
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

// ----------------- UI helpers -----------------
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

function setBusy(isBusy) {
  if (UI.startBtn) UI.startBtn.disabled = isBusy;
  if (UI.loadBtn) UI.loadBtn.disabled = isBusy;
  if (UI.wipeBtn) UI.wipeBtn.disabled = isBusy;
  if (UI.continueBtn) UI.continueBtn.disabled = isBusy;
  if (UI.wildBtn) UI.wildBtn.disabled = isBusy;

  const btns = UI.choices?.querySelectorAll?.("button.choiceBtn") || [];
  btns.forEach(b => b.disabled = isBusy);
}

function renderStory(text) {
  if (!UI.storyText) return;
  UI.storyText.textContent = (text || "").trim();
}

function renderChoices(c, choices) {
  if (!UI.choices) return;
  UI.choices.innerHTML = "";

  const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices returned. Use “Something else” or Continue.";
    UI.choices.appendChild(d);
    return;
  }

  list.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advanceWithChoice(c, n, label);
    UI.choices.appendChild(btn);
  });
}

// ----------------- Click sound -----------------
let audioCtx = null;
function playClick() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    setTimeout(() => o.stop(), 35);
  } catch {}
}

// ----------------- Web Speech (iOS friendly) -----------------
function speechSupported() {
  return ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
}

let VOICES = [];
let VOICES_READY = false;
let SPEECH_UNLOCKED = false;

// Load voices (iOS often loads late)
function initVoices() {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;

  const load = () => {
    const v = synth.getVoices?.() || [];
    if (v.length) {
      VOICES = v;
      VOICES_READY = true;
    }
  };

  load();
  synth.onvoiceschanged = () => load();
}

// MUST be called from a user gesture (tap/click) BEFORE any awaits.
function unlockSpeech() {
  if (!speechSupported()) return;
  if (SPEECH_UNLOCKED) return;

  try {
    // A silent utterance to "unlock" speech on iOS.
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
    SPEECH_UNLOCKED = true;
  } catch {}
}

function pickEnglishVoice() {
  const voices = VOICES.length ? VOICES : (window.speechSynthesis?.getVoices?.() || []);
  if (!voices.length) return null;

  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  if (!en.length) return voices[0] || null;

  // Prefer higher-quality names if present
  const patterns = [
    /siri/i,
    /enhanced/i,
    /premium/i,
    /neural/i,
    /natural/i,
  ];

  for (const rx of patterns) {
    const hit = en.find(v => rx.test(v.name));
    if (hit) return hit;
  }

  // Prefer en-US
  return en.find(v => (v.lang || "").toLowerCase() === "en-us") || en[0];
}

function stopSpeech() {
  if (!speechSupported()) return;
  try { window.speechSynthesis.cancel(); } catch {}
}
function pauseSpeech() {
  if (!speechSupported()) return;
  try { window.speechSynthesis.pause(); } catch {}
}
function resumeSpeech() {
  if (!speechSupported()) return;
  try { window.speechSynthesis.resume(); } catch {}
}

// Speak the text. We schedule it next-tick to reduce iOS flakiness.
function speakIfEnabled(c, text) {
  if (!c?.ttsOn) return;
  if (!speechSupported()) return;

  const cleaned = (text || "").trim();
  if (!cleaned) return;

  stopSpeech();

  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(cleaned);

    const v = pickEnglishVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang || "en-US";
    } else {
      u.lang = "en-US";
    }

    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;

    try {
      window.speechSynthesis.speak(u);
    } catch {}
  }, 0);
}

// ----------------- Worker parsing -----------------
function normalizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => String(x || "").trim()).filter(Boolean).slice(0, 4);
}

function parseTaggedText(rawText) {
  const raw = String(rawText || "");

  const storyMatch = raw.match(/\[STORY\]([\s\S]*?)(?=\[CHOICES\]|\[MEMORY\]|$)/i);
  const choicesMatch = raw.match(/\[CHOICES\]([\s\S]*?)(?=\[MEMORY\]|$)/i);
  const memoryMatch = raw.match(/\[MEMORY\]([\s\S]*?)$/i);

  const storyBlock = (storyMatch?.[1] || "").trim();
  const choicesBlock = (choicesMatch?.[1] || "").trim();
  const memoryBlock = (memoryMatch?.[1] || "").trim();

  const choices = [];
  if (choicesBlock) {
    const lines = choicesBlock.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^([1-4])[\)\.\-:]\s+(.*)$/);
      if (m) choices[parseInt(m[1], 10) - 1] = m[2].trim();
    }
  }

  return {
    storyText: storyBlock,
    choices: normalizeChoices(choices.filter(Boolean)),
    memoryCapsule: memoryBlock,
  };
}

function parseWorkerResponse(json) {
  if (!json || typeof json !== "object") {
    return { storyText: "", choices: [], memoryCapsule: "" };
  }

  // Preferred structured format (matches the worker I gave you)
  if (json.story_text || json.memory_capsule || Array.isArray(json.choices)) {
    return {
      storyText: String(json.story_text || "").trim(),
      choices: normalizeChoices(json.choices),
      memoryCapsule: String(json.memory_capsule || "").trim(),
    };
  }

  // Fallback tagged text
  const raw = json.text ?? json.output_text ?? "";
  return parseTaggedText(raw);
}

// ----------------- Worker call -----------------
async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let json;
  try { json = JSON.parse(bodyText); }
  catch { throw new Error("Worker did not return JSON. Raw:\n" + bodyText.slice(0, 500)); }

  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  if (json?.error && !json.story_text && !json.text) {
    throw new Error(String(json.error));
  }

  return json;
}

// ----------------- Memory building -----------------
function buildStartMemory(seed, rating, pacing) {
  return [
    "[Story Seed]",
    seed,
    "",
    "[Settings]",
    `rating=${rating}`,
    `pacing=${pacing}`,
    "",
    "Instruction: Write in English. Return EXACTLY:",
    "[STORY] ...",
    "[CHOICES] 1..3",
    "[MEMORY] concise continuity capsule",
  ].join("\n");
}

function buildNextMemory(c, choiceNumber, actionText) {
  const cap = c.memoryCapsule || "";
  return [
    "[MEMORY]",
    cap,
    "",
    "[PLAYER_ACTION]",
    `choice_number=${choiceNumber}`,
    `action=${actionText}`,
  ].join("\n");
}

// ----------------- Main flows -----------------
async function startNew() {
  // iOS: unlock speech + load voices on the tap BEFORE awaits
  unlockSpeech();
  initVoices();

  playClick();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const name = (UI.campaignName?.value || "").trim() || "Untitled Campaign";
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const rating = (UI.rating?.value || "PG-13").trim();
  const pacing = (UI.pacing?.value || "long").trim();
  const ttsOn = ((UI.ttsMode?.value || "off") === "on");

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
  setBusy(true);

  try {
    const startMemory = buildStartMemory(seed, rating, pacing);

    const json = await callWorker(workerUrl, {
      action: "Begin the story.",
      memory: startMemory,
    });

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

    renderStory(c.lastStoryText);
    renderChoices(c, c.lastChoices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

    // Autoplay attempt (now that we "unlocked" speech on tap)
    speakIfEnabled(c, c.lastStoryText);

    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

async function advanceWithChoice(c, choiceNumber, actionText) {
  // iOS: unlock speech + voices on user gesture BEFORE awaits
  unlockSpeech();
  initVoices();

  playClick();
  setStatus("Generating...");
  setBusy(true);

  try {
    const updatedMemory = buildNextMemory(c, choiceNumber, actionText);

    const json = await callWorker(c.workerUrl, {
      action: actionText,
      memory: updatedMemory,
    });

    const parsed = parseWorkerResponse(json);

    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";
    c.lastStoryText = (parsed.storyText || "").trim();
    c.lastChoices = parsed.choices || [];

    c.segments = c.segments || [];
    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      choiceTaken: { number: choiceNumber, actionText },
    });

    upsertCampaign(c);

    renderStory(c.lastStoryText);
    renderChoices(c, c.lastChoices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

    // Autoplay attempt
    speakIfEnabled(c, c.lastStoryText);

    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

function replay(c) {
  unlockSpeech();
  initVoices();
  playClick();
  speakIfEnabled(c, c.lastStoryText || "");
}

function undo(c) {
  playClick();
  stopSpeech();

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.lastStoryText = last?.storyText || "";
  c.lastChoices = last?.choices || [];
  upsertCampaign(c);

  renderStory(c.lastStoryText);
  renderChoices(c, c.lastChoices);
  setStatus("Undid last step.");
}

function loadExisting() {
  playClick();
  stopSpeech();

  const list = loadAll();
  if (!list.length) return alert("No saved campaigns found on this device.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);

  renderStory(c.lastStoryText || "");
  renderChoices(c, c.lastChoices || []);
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

  setStatus("Loaded.");
}

function wipeAll() {
  playClick();
  stopSpeech();

  if (!confirm("This deletes ALL campaigns stored on this device. Continue?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local data wiped.");
  showSetup();
}

// ----------------- Boot -----------------
function boot() {
  initVoices();

  // Restore last used worker URL (best effort)
  const last = loadAll()[0];
  if (last?.workerUrl && UI.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c.lastStoryText || "");
    renderChoices(c, c.lastChoices || []);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  // Wire buttons
  if (UI.startBtn) UI.startBtn.onclick = startNew;
  if (UI.loadBtn) UI.loadBtn.onclick = loadExisting;
  if (UI.wipeBtn) UI.wipeBtn.onclick = wipeAll;

  if (UI.libraryBtn) UI.libraryBtn.onclick = () => {
    playClick();
    stopSpeech();
    showSetup();
  };

  if (UI.replayBtn) UI.replayBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (c) replay(c);
  };

  if (UI.undoBtn) UI.undoBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (c) undo(c);
  };

  if (UI.pauseBtn) UI.pauseBtn.onclick = () => {
    playClick();
    if (!speechSupported()) return;
    if (window.speechSynthesis.paused) resumeSpeech();
    else pauseSpeech();
  };

  if (UI.stopBtn) UI.stopBtn.onclick = () => {
    playClick();
    stopSpeech();
  };

  if (UI.continueBtn) UI.continueBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    advanceWithChoice(c, 0, "Continue.");
  };

  if (UI.wildBtn) UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = (UI.wildInput?.value || "").trim();
    if (!t) return alert("Type your action first.");
    if (UI.wildInput) UI.wildInput.value = "";
    advanceWithChoice(c, 0, t);
  };

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // iOS voice list can appear late; poke it again
  if (speechSupported()) {
    setTimeout(() => {
      try { window.speechSynthesis.getVoices(); } catch {}
    }, 800);
  }
}

boot();
