/* Neverending Story PWA – iOS-safe speech version */

const LS_KEY = "nes_campaigns_v3";
const LS_ACTIVE = "nes_active_campaign_v3";

const el = (id) => document.getElementById(id);

// ---------------- UI ----------------
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

// ---------------- Storage ----------------
const loadAll = () => JSON.parse(localStorage.getItem(LS_KEY) || "[]");
const saveAll = (v) => localStorage.setItem(LS_KEY, JSON.stringify(v));
const setActive = (id) => localStorage.setItem(LS_ACTIVE, id);
const getActive = () => localStorage.getItem(LS_ACTIVE);
const findCampaign = (id) => loadAll().find(c => c.id === id);

// ---------------- Speech (CRITICAL FIX) ----------------
let speechUnlocked = false;
let selectedVoice = null;

function unlockSpeech() {
  if (speechUnlocked) return;
  if (!("speechSynthesis" in window)) return;

  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
  speechSynthesis.cancel();

  speechUnlocked = true;
  loadVoices();
}

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;

  selectedVoice =
    voices.find(v => v.lang === "en-US" && /Siri|Enhanced|Premium/i.test(v.name)) ||
    voices.find(v => v.lang === "en-US") ||
    voices[0];
}

speechSynthesis.onvoiceschanged = loadVoices;

function speak(text) {
  if (!speechUnlocked || !selectedVoice) return;
  if (!text) return;

  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = selectedVoice;
  u.lang = "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  speechSynthesis.speak(u);
}

// ---------------- Worker ----------------
async function callWorker(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// ---------------- Rendering ----------------
function renderStory(text) {
  UI.storyText.textContent = text || "";
  speak(text);
}

function renderChoices(c, list) {
  UI.choices.innerHTML = "";
  list.slice(0, 3).forEach((t, i) => {
    const b = document.createElement("button");
    b.className = "choiceBtn";
    b.textContent = `${i + 1}) ${t}`;
    b.onclick = () => advance(c, i + 1, t);
    UI.choices.appendChild(b);
  });
}

// ---------------- Main Logic ----------------
async function startNew() {
  unlockSpeech();

  const c = {
    id: crypto.randomUUID(),
    name: UI.campaignName.value || "Story",
    workerUrl: UI.workerUrl.value,
    ttsOn: UI.ttsMode.value === "on",
    memory: "",
    story: "",
    choices: [],
  };

  setActive(c.id);
  saveCampaign(c);

  const r = await callWorker(c.workerUrl, {
    action: "Begin the story.",
    memory: UI.seed.value,
  });

  c.story = r.story_text || r.text || "";
  c.choices = r.choices || [];

  saveCampaign(c);
  showPlay(c);
  renderStory(c.story);
  renderChoices(c, c.choices);
}

async function advance(c, n, action) {
  unlockSpeech();

  const r = await callWorker(c.workerUrl, {
    action,
    memory: c.memory,
  });

  c.story = r.story_text || r.text || "";
  c.choices = r.choices || [];
  c.memory = r.memory_capsule || c.memory;

  saveCampaign(c);
  renderStory(c.story);
  renderChoices(c, c.choices);
}

function saveCampaign(c) {
  const all = loadAll().filter(x => x.id !== c.id);
  all.unshift(c);
  saveAll(all);
}

function showPlay(c) {
  UI.setupCard.style.display = "none";
  UI.playCard.style.display = "";
  UI.campaignPill.textContent = c.name;
}

// ---------------- Buttons ----------------
UI.startBtn.onclick = startNew;
UI.replayBtn.onclick = () => {
  unlockSpeech();
  const c = findCampaign(getActive());
  if (c) speak(c.story);
};
UI.libraryBtn.onclick = () => location.reload();

// ---------------- Boot ----------------
(function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
})();
