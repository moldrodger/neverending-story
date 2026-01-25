/* Neverending Story – CLEAN APP.JS (Jan 2026)
   - Single source of truth for choices
   - Memory capsule hidden from story view
   - Forced English Apple voice
   - Pause / stop / replay supported
   - Library button fixed
*/

const LS_KEY = "nes_campaigns_v2";
const LS_ACTIVE = "nes_active_campaign_v2";

const $ = (id) => document.getElementById(id);

/* ---------------- UI ---------------- */

const UI = {
  setupCard: $("setupCard"),
  playCard: $("playCard"),
  campaignPill: $("campaignPill"),

  workerUrl: $("workerUrl"),
  campaignName: $("campaignName"),
  rating: $("rating"),
  pacing: $("pacing"),
  ttsMode: $("ttsMode"),
  seed: $("seed"),

  startBtn: $("startBtn"),
  loadBtn: $("loadBtn"),
  wipeBtn: $("wipeBtn"),
  libraryBtn: $("libraryBtn"),

  replayBtn: $("replayBtn"),
  undoBtn: $("undoBtn"),
  continueBtn: $("continueBtn"),

  statusLine: $("statusLine"),
  storyText: $("storyText"),
  choices: $("choices"),
  wildInput: $("wildInput"),
  wildBtn: $("wildBtn"),
  memoryBox: $("memoryBox"),
};

/* ---------------- Storage ---------------- */

const loadAll = () => JSON.parse(localStorage.getItem(LS_KEY) || "[]");
const saveAll = (list) => localStorage.setItem(LS_KEY, JSON.stringify(list));
const setActive = (id) => localStorage.setItem(LS_ACTIVE, id);
const getActiveId = () => localStorage.getItem(LS_ACTIVE);
const findCampaign = (id) => loadAll().find(c => c.id === id);

const upsertCampaign = (c) => {
  const list = loadAll();
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c;
  else list.unshift(c);
  saveAll(list);
};

const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() :
  Math.random().toString(36).slice(2);

/* ---------------- Speech ---------------- */

let activeUtterance = null;

function speak(c, text) {
  if (!c.ttsOn || !("speechSynthesis" in window)) return;

  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;

  // Force best available English voice
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.lang.startsWith("en") &&
    (v.name.includes("Samantha") ||
     v.name.includes("Alex") ||
     v.name.includes("Daniel"))
  );
  if (preferred) u.voice = preferred;

  activeUtterance = u;
  speechSynthesis.speak(u);
}

function stopSpeech() {
  speechSynthesis.cancel();
}

/* ---------------- Worker ---------------- */

async function callWorker(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Worker error");
  return json;
}

/* ---------------- Parsing ---------------- */

function parseWorkerText(raw) {
  let story = "";
  let choices = [];
  let memory = "";

  const storyMatch = raw.match(/\[STORY\]([\s\S]*?)\[CHOICES\]/i);
  if (storyMatch) story = storyMatch[1].trim();

  const choiceMatch = raw.match(/\[CHOICES\]([\s\S]*?)\[MEMORY\]/i);
  if (choiceMatch) {
    choices = choiceMatch[1]
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^\d+\./.test(l))
      .map(l => l.replace(/^\d+\.\s*/, ""));
  }

  const memMatch = raw.match(/\[MEMORY\]([\s\S]*)$/i);
  if (memMatch) memory = memMatch[1].trim();

  return { story, choices, memory };
}

/* ---------------- Rendering ---------------- */

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
  UI.campaignPill.textContent = c.name;
}

function renderChoices(c, choices) {
  UI.choices.innerHTML = "";
  if (!choices.length) return;

  choices.forEach((label, i) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${i + 1}) ${label}`;
    btn.onclick = () => advance(c, i + 1, label);
    UI.choices.appendChild(btn);
  });
}

/* ---------------- Game Flow ---------------- */

async function advance(c, number, action) {
  setStatus("Generating...");
  UI.continueBtn.disabled = true;

  try {
    const payload = {
      action,
      memory: c.memoryCapsule || ""
    };

    const res = await callWorker(c.workerUrl, payload);
    const parsed = parseWorkerText(res.text);

    c.memoryCapsule = parsed.memory;
    c.lastStoryText = parsed.story;
    c.lastChoices = parsed.choices;
    c.segments.push({ story: parsed.story, choices: parsed.choices });

    upsertCampaign(c);

    UI.storyText.textContent = parsed.story;
    renderChoices(c, parsed.choices);
    UI.memoryBox.textContent = c.memoryCapsule;

    speak(c, parsed.story);
    setStatus("Ready.");
  } catch (e) {
    alert(e.message);
    setStatus("Error.");
  } finally {
    UI.continueBtn.disabled = false;
  }
}

/* ---------------- Controls ---------------- */

function replay() {
  const c = findCampaign(getActiveId());
  if (c?.lastStoryText) speak(c, c.lastStoryText);
}

function undo() {
  const c = findCampaign(getActiveId());
  if (!c || c.segments.length < 2) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];
  c.lastStoryText = last.story;
  c.lastChoices = last.choices;

  upsertCampaign(c);
  UI.storyText.textContent = last.story;
  renderChoices(c, last.choices);
}

async function startNew() {
  const c = {
    id: uuid(),
    name: UI.campaignName.value || "Untitled",
    workerUrl: UI.workerUrl.value.trim(),
    rating: UI.rating.value,
    pacing: UI.pacing.value,
    ttsOn: UI.ttsMode.value === "on",
    memoryCapsule: "",
    lastStoryText: "",
    lastChoices: [],
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  await advance(c, 0, UI.seed.value || "Begin the story.");
}

function loadExisting() {
  const list = loadAll();
  if (!list.length) return alert("No saved campaigns.");

  const pick = prompt(list.map((c, i) => `${i + 1}) ${c.name}`).join("\n"));
  const idx = parseInt(pick, 10) - 1;
  if (!list[idx]) return;

  const c = list[idx];
  setActive(c.id);
  showPlay(c);

  UI.storyText.textContent = c.lastStoryText;
  renderChoices(c, c.lastChoices);
  UI.memoryBox.textContent = c.memoryCapsule;
}

/* ---------------- Boot ---------------- */

function boot() {
  UI.startBtn.onclick = startNew;
  UI.loadBtn.onclick = loadExisting;
  UI.wipeBtn.onclick = () => {
    if (confirm("Delete all campaigns?")) {
      localStorage.clear();
      showSetup();
    }
  };

  UI.libraryBtn.onclick = showSetup;
  UI.replayBtn.onclick = replay;
  UI.undoBtn.onclick = undo;
  UI.continueBtn.onclick = () =>
    advance(findCampaign(getActiveId()), 0, "Continue naturally.");

  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    const t = UI.wildInput.value.trim();
    if (!t) return;
    UI.wildInput.value = "";
    advance(c, 0, t);
  };

  const active = findCampaign(getActiveId());
  if (active) {
    showPlay(active);
    UI.storyText.textContent = active.lastStoryText;
    renderChoices(active, active.lastChoices);
  } else {
    showSetup();
  }
}

boot();
