/* Neverending Story PWA (Local storage, worker-backed)
   Worker response expected:
   { story: string, choices: [string,string,string], memory: string }
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

  libraryBtn: el("libraryBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),
  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"),
};

let audioEl = null;
let isPaused = false;

// ---------- local storage ----------
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
  UI.memoryBox.textContent = c.memory || "";
}

// ---------- audio (your click/pause system already works with your HTML) ----------
function stopAudio() {
  if (audioEl) {
    try { audioEl.pause(); } catch {}
    audioEl = null;
  }
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  isPaused = false;
}

function speakIfEnabled(c, text) {
  if (!c.ttsOn) return;
  if (!("speechSynthesis" in window)) return;

  stopAudio();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US"; // force English
  window.speechSynthesis.speak(u);
}

function clickSound() {
  // If you already added a click sound in your prior version, keep it there.
  // This is a safe no-op placeholder to avoid errors if you removed it.
}

// ---------- worker ----------
async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();

  let json;
  try { json = JSON.parse(raw); }
  catch {
    throw new Error("Worker did not return JSON. Raw:\n" + raw.slice(0, 500));
  }

  if (!res.ok) {
    throw new Error(`Worker error ${res.status}: ` + (json?.error || raw.slice(0, 300)));
  }

  return json;
}

function normalizeWorkerJson(json) {
  // expected: { story, choices, memory }
  const story = (typeof json.story === "string") ? json.story.trim() : "";
  const memory = (typeof json.memory === "string") ? json.memory.trim() : "";
  const choices = Array.isArray(json.choices) ? json.choices.map(x => String(x || "").trim()).filter(Boolean) : [];

  return { story, memory, choices };
}

function renderChoices(c, choices) {
  UI.choices.innerHTML = "";

  if (!choices || choices.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No choices returned. Use “Something else” below.";
    UI.choices.appendChild(p);
    return;
  }

  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.type = "button";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advance(c, { mode: "choice", number: n, actionText: label });
    UI.choices.appendChild(btn);
  });
}

async function advance(c, { mode, number, actionText }) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;
  UI.wildBtn.disabled = true;

  clickSound();

  try {
    // Build memory we send to worker.
    // IMPORTANT: we send the existing memory + the player's latest action.
    const memoryToSend = [
      c.memory || "",
      "",
      "[Player Action]",
      `number=${number}`,
      `action=${actionText}`,
    ].join("\n").trim();

    const payload = {
      action: actionText,
      memory: memoryToSend
    };

    const json = await callWorker(c.workerUrl, payload);
    const parsed = normalizeWorkerJson(json);

    if (!parsed.story) {
      // Choices without story is exactly your current bug — show raw for debugging.
      throw new Error("Worker returned choices but no story. (This usually means the model output was malformed.) Try again once; if it repeats, open Debug/Memory and send me the raw JSON response.");
    }

    c.memory = parsed.memory;
    c.lastStory = parsed.story;
    c.lastChoices = parsed.choices;

    c.segments = c.segments || [];
    c.segments.push({
      at: Date.now(),
      story: c.lastStory,
      choices: c.lastChoices,
      took: { number, actionText, mode }
    });

    upsertCampaign(c);

    UI.storyText.textContent = c.lastStory;
    UI.memoryBox.textContent = c.memory || "";
    renderChoices(c, c.lastChoices);

    speakIfEnabled(c, c.lastStory);
    setStatus("Ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    UI.continueBtn.disabled = false;
    UI.wildBtn.disabled = false;
  }
}

function replay(c) {
  if (!c?.lastStory) return;
  speakIfEnabled(c, c.lastStory);
}

function undo(c) {
  c.segments = c.segments || [];
  if (c.segments.length === 0) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.lastStory = last ? last.story : "";
  c.lastChoices = last ? last.choices : [];
  // keep memory as-is; or you can restore from last if you store it per segment later

  upsertCampaign(c);

  UI.storyText.textContent = c.lastStory || "";
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

  stopAudio();

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating,
    pacing,
    ttsOn,
    memory: "",
    lastStory: "",
    lastChoices: [],
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

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
    ].join("\n");

    const json = await callWorker(workerUrl, { action: "Begin the story.", memory: startMemory });
    const parsed = normalizeWorkerJson(json);

    if (!parsed.story) throw new Error("No story returned from worker on START.");

    c.memory = parsed.memory;
    c.lastStory = parsed.story;
    c.lastChoices = parsed.choices;

    c.segments.push({
      at: Date.now(),
      story: c.lastStory,
      choices: c.lastChoices,
      took: { number: 0, actionText: "START", mode: "start" }
    });

    upsertCampaign(c);

    UI.storyText.textContent = c.lastStory;
    UI.memoryBox.textContent = c.memory || "";
    renderChoices(c, c.lastChoices);

    speakIfEnabled(c, c.lastStory);
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

  UI.storyText.textContent = c.lastStory || "";
  UI.memoryBox.textContent = c.memory || "";
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
  // Restore last worker URL if any
  const last = loadAll()[0];
  if (last?.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    UI.storyText.textContent = c.lastStory || "";
    UI.memoryBox.textContent = c.memory || "";
    renderChoices(c, c.lastChoices || []);
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  // Buttons
  UI.startBtn.onclick = startNew;
  UI.loadBtn.onclick = loadExisting;
  UI.wipeBtn.onclick = wipeAll;

  UI.libraryBtn.onclick = () => {
    stopAudio();
    showSetup();
  };

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
    advance(c, { mode: "continue", number: 0, actionText: "Continue naturally." });
  };

  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advance(c, { mode: "wild", number: 0, actionText: t });
  };

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
