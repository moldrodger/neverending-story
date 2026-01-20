const LS_KEY = "nes_campaigns_v2";
const LS_ACTIVE = "nes_active_campaign_v2";

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
  UI.memoryBox.textContent = c.memory || "";
}

function pickEnglishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const en = voices.filter(v => (v.lang || "").toLowerCase().startsWith("en"));
  // Prefer Siri / premium-ish if present
  const preferred = en.find(v => /siri|premium|enhanced/i.test(v.name)) || en[0];
  return preferred || null;
}

function speakEnglish(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";             // Force English (fixes the “unknown language” issue)
  u.rate = 1.0;
  u.pitch = 1.0;

  const voice = pickEnglishVoice();
  if (voice) u.voice = voice;

  window.speechSynthesis.speak(u);
}

async function callWorker(workerUrl, payload) {
  const res = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error("Worker did not return JSON:\n" + raw.slice(0, 800)); }

  if (!res.ok) {
    throw new Error(json?.error ? JSON.stringify(json) : ("Worker error:\n" + raw.slice(0, 800)));
  }
  return json;
}

function render(c) {
  UI.storyText.textContent = c.last?.story_text || "";
  UI.memoryBox.textContent = c.memory || "";
  UI.choices.innerHTML = "";

  const choices = c.last?.choices || [];
  if (!choices.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices returned.";
    UI.choices.appendChild(d);
    return;
  }

  choices.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advance(c, { choice_number: n, choice_text: label });
    UI.choices.appendChild(btn);
  });
}

async function advance(c, { choice_number = 0, choice_text = "", action = "" }) {
  setStatus("Generating segment...");
  UI.continueBtn.disabled = true;

  try {
    const payload = {
      rating: c.rating,
      pacing: c.pacing,
      memory: c.memory || "",
      choice_number,
      choice_text,
      action,
    };

    const json = await callWorker(c.workerUrl, payload);

    c.memory = json.memory_capsule || c.memory || "";
    c.last = {
      story_text: json.story_text || "",
      choices: Array.isArray(json.choices) ? json.choices : [],
    };

    c.segments = c.segments || [];
    c.segments.push({
      at: Date.now(),
      memory: c.memory,
      last: c.last,
      took: { choice_number, choice_text, action },
    });

    upsertCampaign(c);
    render(c);

    if (c.ttsOn && c.last.story_text) speakEnglish(c.last.story_text);

    setStatus("Ready.");
  } finally {
    UI.continueBtn.disabled = false;
  }
}

async function startNew() {
  const workerUrl = UI.workerUrl.value.trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const seed = UI.seed.value.trim();
  if (!seed) return alert("Enter a story seed.");

  const c = {
    id: uuid(),
    name: (UI.campaignName.value.trim() || "Untitled Campaign"),
    workerUrl,
    rating: UI.rating.value,
    pacing: UI.pacing.value,
    ttsOn: (UI.ttsMode.value === "on"),
    memory: `Story Seed:\n${seed}\n\n(Keep this seed in mind as the basis for the world.)`,
    last: { story_text: "", choices: [] },
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);

  showPlay(c);
  setStatus("Starting...");
  await advance(c, { action: "Begin the story." });
}

function loadExisting() {
  const list = loadAll();
  if (!list.length) return alert("No campaigns saved on this device.");

  const names = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign number:\n\n" + names);
  const n = parseInt(pick || "", 10);
  if (!n || n < 1 || n > list.length) return;

  const c = list[n - 1];
  setActive(c.id);
  showPlay(c);
  render(c);
  setStatus("Loaded.");
}

function wipeAll() {
  if (!confirm("Delete ALL local campaigns on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  showSetup();
}

function undo() {
  const c = findCampaign(getActiveId());
  if (!c?.segments?.length) return;

  c.segments.pop();
  const prev = c.segments[c.segments.length - 1];
  if (prev) {
    c.memory = prev.memory;
    c.last = prev.last;
  } else {
    c.memory = "";
    c.last = { story_text: "", choices: [] };
  }
  upsertCampaign(c);
  render(c);
  setStatus("Undid last step.");
}

function replay() {
  const c = findCampaign(getActiveId());
  if (!c?.ttsOn) return;
  if (!c?.last?.story_text) return;
  speakEnglish(c.last.story_text);
}

function boot() {
  const last = loadAll()[0];
  if (last?.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActiveId();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    render(c);
    setStatus("Loaded.");
  } else {
    showSetup();
  }

  UI.startBtn.onclick = startNew;
  UI.loadBtn.onclick = loadExisting;
  UI.wipeBtn.onclick = wipeAll;

  UI.libraryBtn.onclick = showSetup;
  UI.undoBtn.onclick = undo;
  UI.replayBtn.onclick = replay;

  UI.continueBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    advance(c, { choice_number: 0, action: "" });
  };

  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advance(c, { choice_number: 0, action: t });
  };

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // iOS voices load async; prompt them to load
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {};
  }
}

boot();