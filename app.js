/* Neverending Story PWA — Clean rebuild (Worker-backed, localStorage)
   Worker must return JSON: { story_text, choices[], memory_capsule }
*/

const LS_KEY = "nes_campaigns_v2";
const LS_ACTIVE = "nes_active_campaign_v2";

const el = (id) => document.getElementById(id);

const UI = {
  setupCard: el("setupCard"),
  playCard: el("playCard"),
  libraryList: el("libraryList"),
  campaignPill: el("campaignPill"),
  statusLine: el("statusLine"),

  workerUrl: el("workerUrl"),
  campaignName: el("campaignName"),
  rating: el("rating"),
  pacing: el("pacing"),
  voiceMode: el("voiceMode"),
  seed: el("seed"),

  startBtn: el("startBtn"),
  wipeBtn: el("wipeBtn"),

  backBtn: el("backBtn"),
  replayBtn: el("replayBtn"),
  undoBtn: el("undoBtn"),
  continueBtn: el("continueBtn"),

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
function removeCampaign(id) {
  const list = loadAll().filter(c => c.id !== id);
  saveAll(list);
  if (getActiveId() === id) localStorage.removeItem(LS_ACTIVE);
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
  renderLibrary();
}
function showPlay(c) {
  UI.setupCard.style.display = "none";
  UI.playCard.style.display = "";
  UI.campaignPill.textContent = c.name || "Untitled";
  UI.memoryBox.textContent = c.memoryCapsule || "";
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
  catch { throw new Error("Worker did not return JSON. Raw:\n" + raw.slice(0, 600)); }

  if (!res.ok) {
    throw new Error(json?.error ? `${json.error}` : `HTTP ${res.status}`);
  }
  return json;
}

function normalizeResponse(json) {
  const storyText = (json?.story_text ?? "").toString().trim();
  const memoryCapsule = (json?.memory_capsule ?? "").toString().trim();
  const choices = Array.isArray(json?.choices) ? json.choices.map(x => (x ?? "").toString().trim()).filter(Boolean).slice(0, 4) : [];
  return { storyText, memoryCapsule, choices };
}

/* ---------- TTS (iOS quirks friendly) ---------- */
let voicesCache = [];
function refreshVoices() {
  try { voicesCache = window.speechSynthesis?.getVoices?.() || []; } catch { voicesCache = []; }
}
function pickEnglishVoice() {
  // Prefer Siri voices if present; otherwise any English voice.
  const v = voicesCache;
  const isEnglish = (x) => (x?.lang || "").toLowerCase().startsWith("en");
  const isSiri = (x) => (x?.name || "").toLowerCase().includes("siri");

  return v.find(x => isEnglish(x) && isSiri(x)) ||
         v.find(x => isEnglish(x)) ||
         null;
}
function speakIfEnabled(c, text) {
  if (!c.ttsOn) return;
  if (!("speechSynthesis" in window)) return;
  if (!text) return;

  // iOS sometimes loads voices async
  refreshVoices();
  const voice = pickEnglishVoice();

  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = (voice?.lang) || "en-US";
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

// Some iOS versions require this hook
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => refreshVoices();
  refreshVoices();
}

/* ---------- UI rendering ---------- */
function renderChoices(c, choices) {
  UI.choices.innerHTML = "";
  if (!choices || choices.length === 0) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices returned. Use “Something else” below.";
    UI.choices.appendChild(d);
    return;
  }

  choices.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${idx + 1}) ${label}`;
    btn.onclick = () => advance(c, { type: "choice", index: idx + 1, text: label });
    UI.choices.appendChild(btn);
  });
}

function renderLibrary() {
  const list = loadAll();
  UI.libraryList.innerHTML = "";

  if (list.length === 0) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No campaigns yet. Start one below.";
    UI.libraryList.appendChild(p);
    return;
  }

  list.forEach((c) => {
    const wrap = document.createElement("div");
    wrap.style.flex = "1";
    wrap.style.minWidth = "260px";

    const card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "0";
    card.style.padding = "12px";

    const title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = c.name || "Untitled";

    const meta = document.createElement("div");
    meta.className = "muted small";
    const segs = (c.segments?.length || 0);
    meta.textContent = `${segs} segment(s) • rating=${c.rating} • pacing=${c.pacing}`;

    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "10px";

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load";
    loadBtn.onclick = () => {
      setActive(c.id);
      const fresh = findCampaign(c.id);
      if (fresh) {
        showPlay(fresh);
        UI.storyText.textContent = fresh.lastStoryText || "";
        UI.memoryBox.textContent = fresh.memoryCapsule || "";
        renderChoices(fresh, fresh.lastChoices || []);
        setStatus("Loaded.");
      }
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (!confirm(`Delete "${c.name}" from this device?`)) return;
      removeCampaign(c.id);
      renderLibrary();
    };

    row.appendChild(loadBtn);
    row.appendChild(delBtn);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(row);
    wrap.appendChild(card);
    UI.libraryList.appendChild(wrap);
  });
}

/* ---------- Story advancing ---------- */
async function advance(c, evt) {
  setStatus("Generating next segment...");
  UI.continueBtn.disabled = true;

  try {
    const payload = {
      mode: "solo",
      rating: c.rating,
      pacing: c.pacing,
      seed: c.seed || "",
      action: evt.type === "wild"
        ? evt.text
        : evt.type === "choice"
          ? `I choose option ${evt.index}: ${evt.text}`
          : "Continue naturally.",
      memory: c.memoryCapsule || "",
    };

    const json = await callWorker(c.workerUrl, payload);
    const parsed = normalizeResponse(json);

    c.memoryCapsule = parsed.memoryCapsule || c.memoryCapsule || "";
    c.lastStoryText = parsed.storyText || "";
    c.lastChoices = parsed.choices || [];

    c.segments = c.segments || [];
    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      event: evt,
    });

    upsertCampaign(c);

    UI.storyText.textContent = c.lastStoryText || "";
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
  speakIfEnabled(c, c.lastStoryText || "");
}

function undo(c) {
  c.segments = c.segments || [];
  if (c.segments.length <= 1) {
    setStatus("Nothing to undo.");
    return;
  }
  c.segments.pop();
  const last = c.segments[c.segments.length - 1];
  c.lastStoryText = last?.storyText || "";
  c.lastChoices = last?.choices || [];
  // NOTE: memoryCapsule is not perfectly rewindable without snapshotting each turn.
  // We keep the current memory capsule; it’s “good enough” for most use.
  upsertCampaign(c);

  UI.storyText.textContent = c.lastStoryText;
  renderChoices(c, c.lastChoices);
  setStatus("Undid last step.");
}

/* ---------- Start ---------- */
async function startNew() {
  const workerUrl = UI.workerUrl.value.trim();
  if (!workerUrl) return alert("Enter your Worker URL.");

  const name = UI.campaignName.value.trim() || "Untitled Campaign";
  const seed = UI.seed.value.trim();
  if (!seed) return alert("Enter a story seed (what kind of story/world).");

  const c = {
    id: uuid(),
    name,
    workerUrl,
    rating: UI.rating.value,
    pacing: UI.pacing.value,
    ttsOn: UI.voiceMode.value === "on",
    seed,
    memoryCapsule: "",
    lastStoryText: "",
    lastChoices: [],
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);
  showPlay(c);

  // First turn: tell worker to begin using the seed
  await advance(c, { type: "start", text: "Begin the story." });
}

function wipeAll() {
  if (!confirm("This deletes ALL campaigns on this device. Continue?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local data wiped.");
  showSetup();
}

function boot() {
  // restore last used worker URL if any
  const last = loadAll()[0];
  if (last?.workerUrl) UI.workerUrl.value = last.workerUrl;

  // wire buttons
  UI.startBtn.onclick = startNew;
  UI.wipeBtn.onclick = wipeAll;

  UI.backBtn.onclick = () => showSetup();

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
    advance(c, { type: "continue", text: "Continue naturally." });
  };

  UI.wildBtn.onclick = () => {
    const c = findCampaign(getActiveId());
    if (!c) return;
    const t = UI.wildInput.value.trim();
    if (!t) return alert("Type your action first.");
    UI.wildInput.value = "";
    advance(c, { type: "wild", text: t });
  };

  // restore active campaign if any
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

  // service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();