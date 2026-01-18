/* Neverending Story PWA (Local storage, worker-backed)
   - Uses worker endpoint you already have.
   - Expects worker JSON that includes either:
     A) { text: "...[Memory Capsule]...", audio_base64: "..." }
     or
     B) { story_text: "...", memory_capsule: "...", choices: [...] }
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

function setStatus(msg) {
  UI.statusLine.textContent = msg;
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
}

function speakIfEnabled(c, text) {
  if (!c.ttsOn) return;
  if (!("speechSynthesis" in window)) return;

  // cancel any ongoing speech
  window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
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

  // Case A: legacy text blob with [Memory Capsule]
  const raw = (json && (json.text || json.story_text)) ? (json.text || json.story_text) : "";
  let storyPart = raw;
  let memPart = "";

  const marker = "[Memory Capsule]";
  const idx = raw.indexOf(marker);
  if (idx >= 0) {
    storyPart = raw.slice(0, idx).trim();
    memPart = raw.slice(idx + marker.length).trim();
  }

  // Try to extract numbered choices from the bottom of storyPart:
  // looks for lines starting with 1,2,3 (e.g., "1) ..." or "1. ...")
  const lines = storyPart.split("\n").map(l => l.trim()).filter(Boolean);
  const extracted = [];
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) {
    const m = lines[i].match(/^([123])[\)\.\-:]\s+(.*)$/);
    if (m) extracted[parseInt(m[1], 10) - 1] = m[2].trim();
  }
  const choices = extracted.filter(Boolean);

  return {
    storyText: storyPart,
    memoryCapsule: memPart,
    choices,
  };
}

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

  return json;
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

function renderChoices(c, choices) {
  UI.choices.innerHTML = "";
  if (!choices || choices.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No choices detected. You can use “Something else” below.";
    UI.choices.appendChild(p);
    return;
  }

  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advanceWithChoice(c, n, label);
    UI.choices.appendChild(btn);
  });
}

async function advanceWithChoice(c, choiceNumber, actionText) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;

  try {
    const updatedMemory = buildUpdatedMemory(c, choiceNumber, actionText);
    const payload = { choice: "CONTINUE", number: choiceNumber, memory: updatedMemory };

    const json = await callWorker(c.workerUrl, payload);
    const parsed = parseWorkerResponse(json);

    // update campaign state
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

    speakIfEnabled(c, c.lastStoryText);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    UI.continueBtn.disabled = false;
  }
}

function replay(c) {
  if (!c.lastStoryText) return;
  speakIfEnabled(c, c.lastStoryText);
}

function undo(c) {
  c.segments = c.segments || [];
  if (c.segments.length === 0) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  if (last) {
    c.lastStoryText = last.storyText;
    c.lastChoices = last.choices;
  } else {
    c.lastStoryText = "";
    c.lastChoices = [];
  }

  upsertCampaign(c);
  UI.storyText.textContent = c.lastStoryText || "";
  renderChoices(c, c.lastChoices || []);
  setStatus("Undid last step.");
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

  // Start: we call CONTINUE with number=0 but with a clear start directive in memory.
  setStatus("Starting story...");
  UI.continueBtn.disabled = true;

  try {
    const startMemory = [
      "[Story Seed]",
      seed,
      "",
      "[Settings]",
      `rating=${rating}`,
      `pacing=${pacing}`,
      "",
      "Instruction: Start a new freeform solo story. Provide a long story segment, then 3 numbered choices (1-3) plus a 'Something else' option. Include a [Memory Capsule] section at the end.",
    ].join("\n");

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

    speakIfEnabled(c, c.lastStoryText);
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
  if (list.length === 0) return alert("No local campaigns found.");

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

function boot() {
  // Restore last used worker URL if any
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

  // Wire buttons
  UI.startBtn.onclick = startNew;
  UI.loadBtn.onclick = loadExisting;
  UI.wipeBtn.onclick = wipeAll;

  UI.backToLibraryBtn.onclick = () => showSetup();
  UI.replayBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (c) replay(c);
  };
  UI.undoBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (c) undo(c);
  };

  UI.continueBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    // If user presses Continue without picking: treat as wildcard “continue naturally”
    advanceWithChoice(c, 0, "Continue the scene without changing course.");
  };

  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advanceWithChoice(c, 0, t);
  };

  // Register service worker (PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();