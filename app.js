/* Neverending Story PWA (Local storage, worker-backed)
   CLEAN BUILD for NEW Worker contract:
   - Send: { action, memory, pace }
   - Receive: { story, choices, memory, raw_text }
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

// -------------------- Storage helpers --------------------
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

// -------------------- UI helpers --------------------
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

// -------------------- Better TTS (still built-in voices) --------------------
let cachedVoice = null;

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  return (
    voices.find(v => /Siri|Enhanced|Premium/i.test(v.name)) ||
    voices.find(v => /Google/i.test(v.name)) ||
    voices.find(v => /English/i.test(v.lang)) ||
    voices[0]
  );
}

function speakIfEnabled(c, text) {
  if (!c.ttsOn) return;
  if (!("speechSynthesis" in window)) return;
  if (!text) return;

  // cancel any ongoing speech
  window.speechSynthesis.cancel();

  if (!cachedVoice) cachedVoice = pickVoice();

  const u = new SpeechSynthesisUtterance(text);
  if (cachedVoice) u.voice = cachedVoice;
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = pickVoice();
  };
}

// -------------------- Worker response parsing --------------------
function parseWorkerResponse(json) {
  // New worker contract: { story, choices, memory }
  if (json && (typeof json.story === "string" || Array.isArray(json.choices) || typeof json.memory === "string")) {
    return {
      storyText: (json.story || "").trim(),
      memoryCapsule: (json.memory || "").trim(),
      choices: Array.isArray(json.choices) ? json.choices : [],
      rawText: (json.raw_text || ""),
    };
  }

  // Legacy fallback: { text: "..."} (best-effort)
  const raw = (json && (json.text || "")) ? (json.text || "") : "";
  return { storyText: raw.trim(), memoryCapsule: "", choices: [], rawText: raw };
}

// -------------------- Worker call --------------------
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

  // Bubble worker errors nicely
  if (!res.ok || json?.error) {
    const msg = json?.error ? `${json.error}` : `HTTP ${res.status}`;
    const detail = json?.details ? `\n\n${json.details}` : "";
    const raw = json?.raw ? `\n\nRAW:\n${JSON.stringify(json.raw, null, 2).slice(0, 1200)}` : "";
    throw new Error(msg + detail + raw);
  }

  return json;
}

// -------------------- Choices UI --------------------
function renderChoices(c, choices) {
  UI.choices.innerHTML = "";

  const list = Array.isArray(choices) ? choices : [];
  if (list.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No choices returned. Use “Something else” below.";
    UI.choices.appendChild(p);
    return;
  }

  // Show up to 3 choice buttons (you can expand later)
  list.slice(0, 3).forEach((label, idx) => {
    const n = idx + 1;
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${n}) ${label}`;
    btn.onclick = () => advanceWithAction(c, `I choose option ${n}: ${label}`, { number: n, label });
    UI.choices.appendChild(btn);
  });
}

// -------------------- Core advance --------------------
async function advanceWithAction(c, actionText, choiceTakenMeta) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;
  UI.wildBtn.disabled = true;

  try {
    const payload = {
      action: actionText,
      memory: (c.memoryCapsule || "").trim(),
      pace: (c.pacing || "short"),
    };

    const json = await callWorker(c.workerUrl, payload);
    const parsed = parseWorkerResponse(json);

    // Update campaign state
    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";
    c.lastStoryText = parsed.storyText || "";
    c.lastChoices = parsed.choices || [];
    c.segments = c.segments || [];

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      memoryCapsule: c.memoryCapsule,
      choiceTaken: choiceTakenMeta || { number: 0, label: "CONTINUE" },
    });

    upsertCampaign(c);

    // Render
    UI.storyText.textContent = c.lastStoryText || "(No story text returned.)";
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
    UI.wildBtn.disabled = false;
  }
}

// -------------------- Replay / Undo --------------------
function replay(c) {
  if (!c?.lastStoryText) return;
  speakIfEnabled(c, c.lastStoryText);
}

function undo(c) {
  c.segments = c.segments || [];
  if (c.segments.length === 0) return;

  // Remove latest
  c.segments.pop();

  const last = c.segments[c.segments.length - 1];
  if (last) {
    c.lastStoryText = last.storyText || "";
    c.lastChoices = last.choices || [];
    c.memoryCapsule = last.memoryCapsule || "";
  } else {
    c.lastStoryText = "";
    c.lastChoices = [];
    c.memoryCapsule = "";
  }

  upsertCampaign(c);

  UI.storyText.textContent = c.lastStoryText || "";
  UI.memoryBox.textContent = c.memoryCapsule || "";
  renderChoices(c, c.lastChoices || []);
  setStatus("Undid last step.");
}

// -------------------- Start / Load / Wipe --------------------
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

  try {
    const action =
      `Start a new freeform solo story.\n` +
      `Seed: ${seed}\n` +
      `Rating: ${rating}\n` +
      `Pacing: ${pacing}\n` +
      `Make it immersive, character-driven, and consistent.\n` +
      `Do NOT quote or reproduce any published text verbatim.\n`;

    await advanceWithAction(c, action, { number: 0, label: "START" });
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

// -------------------- Boot --------------------
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

  // Buttons
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

  // Continue = gentle continuation (no big choice)
  UI.continueBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    advanceWithAction(c, "Continue the scene naturally with strong detail and forward momentum.", { number: 0, label: "CONTINUE" });
  };

  // Something else (typed)
  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advanceWithAction(c, t, { number: 0, label: "SOMETHING ELSE" });
  };

  // Register service worker (PWA)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();