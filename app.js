/* Neverending Story PWA – OpenAI TTS (Option C), iOS-safe, cost-optimized
   Requires Worker:
     - POST /      -> { story_text, choices[], memory_capsule }
     - POST /tts   -> MP3 audio stream for { text }
*/

const LS_KEY = "nes_campaigns_v4";
const LS_ACTIVE = "nes_active_campaign_v4";

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
  pauseBtn: el("pauseBtn"),   // optional in HTML
  stopBtn: el("stopBtn"),     // optional in HTML
  undoBtn: el("undoBtn"),

  statusLine: el("statusLine"),
  storyText: el("storyText"),
  choices: el("choices"),

  wildInput: el("wildInput"),
  wildBtn: el("wildBtn"),
  continueBtn: el("continueBtn"),

  memoryBox: el("memoryBox"), // debug only
};

// ---------------- Storage ----------------
function loadAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveAll(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
function setActive(id) { localStorage.setItem(LS_ACTIVE, id); }
function getActive() { return localStorage.getItem(LS_ACTIVE); }
function findCampaign(id) { return loadAll().find(c => c.id === id) || null; }

function upsertCampaign(c) {
  const all = loadAll().filter(x => x.id !== c.id);
  all.unshift(c);
  saveAll(all);
}

function uuid() {
  // iOS 16+ supports crypto.randomUUID; fallback just in case
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = (ch === "x") ? r : (r & 3) | 8;
    return v.toString(16);
  });
}

// ---------------- UI helpers ----------------
function setStatus(msg) {
  if (UI.statusLine) UI.statusLine.textContent = msg;
}

function showSetup() {
  if (UI.setupCard) UI.setupCard.style.display = "";
  if (UI.playCard) UI.playCard.style.display = "none";
  if (UI.campaignPill) UI.campaignPill.textContent = "No campaign";
}

function showPlay(c) {
  if (UI.setupCard) UI.setupCard.style.display = "none";
  if (UI.playCard) UI.playCard.style.display = "";
  if (UI.campaignPill) UI.campaignPill.textContent = c?.name || "Untitled";
  if (UI.memoryBox) UI.memoryBox.textContent = c?.memoryCapsule || "";
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

// ---------------- Click sound (no asset file) ----------------
let audioCtx = null;
function playClick() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.03;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    setTimeout(() => o.stop(), 30);
  } catch {}
}

// ---------------- iOS audio unlock + TTS player ----------------
let audioUnlocked = false;
let audioEl = null;
let lastSpokenText = "";
let lastSpokenKey = "";
let isPaused = false;

function getTtsUrl(workerUrl) {
  // workerUrl may be https://xyz.workers.dev/ or https://xyz.workers.dev
  const u = new URL(workerUrl);
  u.pathname = "/tts";
  u.search = "";
  return u.toString();
}

async function unlockAudioOnce() {
  // iOS requires a user gesture to allow audio playback.
  if (audioUnlocked) return;
  audioEl = audioEl || new Audio();

  // Try to "prime" playback with a silent tiny sound
  // Safari can still block if not called directly inside a tap event,
  // but this improves reliability after first user interaction.
  try {
    audioEl.src = "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAA"; // minimal stub
    await audioEl.play();
  } catch {}
  try { audioEl.pause(); } catch {}
  audioUnlocked = true;
}

function stopAudio() {
  if (!audioEl) return;
  try { audioEl.pause(); } catch {}
  try { audioEl.currentTime = 0; } catch {}
  isPaused = false;
}

function pauseAudio() {
  if (!audioEl) return;
  try { audioEl.pause(); } catch {}
  isPaused = true;
}

function resumeAudio() {
  if (!audioEl) return;
  try { audioEl.play(); } catch {}
  isPaused = false;
}

// ---- Client-side cache (Cache API). Keeps replays free + instant. ----
const AUDIO_CACHE_NAME = "nes_tts_cache_v1";
async function cacheGet(key) {
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const res = await cache.match(key);
    if (!res) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
async function cachePut(key, blob) {
  try {
    const cache = await caches.open(AUDIO_CACHE_NAME);
    await cache.put(key, new Response(blob));
  } catch {}
}

function makeTtsCacheKey(ttsUrl, text) {
  // lightweight key; worker also caches in KV
  return `${ttsUrl}#${hashString(text)}`;
}

function hashString(str) {
  // non-crypto fast hash for cache key
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ---- Chunking: helps start faster + reduces re-TTS when continuing ----
function chunkTextForTts(text, maxChars = 900) {
  const t = String(text || "").trim();
  if (!t) return [];
  // Split by paragraphs/sentences, keep under maxChars
  const parts = t
    .split(/\n{2,}/g)
    .map(p => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = "";
  for (const p of parts) {
    if ((buf + "\n\n" + p).trim().length <= maxChars) {
      buf = buf ? (buf + "\n\n" + p) : p;
    } else {
      if (buf) chunks.push(buf);
      if (p.length <= maxChars) {
        chunks.push(p);
        buf = "";
      } else {
        // fallback: sentence split
        const sents = p.split(/(?<=[.!?])\s+/g);
        let b2 = "";
        for (const s of sents) {
          if ((b2 + " " + s).trim().length <= maxChars) {
            b2 = b2 ? (b2 + " " + s) : s;
          } else {
            if (b2) chunks.push(b2);
            b2 = s;
          }
        }
        if (b2) chunks.push(b2);
        buf = "";
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function speakWithOpenAiTts(campaign, storyText) {
  if (!campaign?.ttsOn) return;
  if (!storyText || !storyText.trim()) return;

  // iOS must be unlocked once by a user gesture
  if (!audioUnlocked) return;

  audioEl = audioEl || new Audio();
  stopAudio();

  // Save for Replay
  lastSpokenText = storyText;
  lastSpokenKey = "";

  const ttsUrl = getTtsUrl(campaign.workerUrl);

  // Speak in chunks sequentially
  const chunks = chunkTextForTts(storyText, 900);
  if (!chunks.length) return;

  setStatus("Speaking...");

  for (let i = 0; i < chunks.length; i++) {
    // If user hit Stop, break
    if (!audioEl) break;
    if (audioEl.paused && !isPaused && audioEl.currentTime === 0 && i > 0) {
      // stopped
      break;
    }
    // If paused, wait until resumed
    while (isPaused) {
      await sleep(150);
    }

    const chunk = chunks[i];
    const cacheKey = makeTtsCacheKey(ttsUrl, chunk);
    lastSpokenKey = cacheKey;

    let blob = await cacheGet(cacheKey);
    if (!blob) {
      blob = await fetchTtsBlob(ttsUrl, chunk);
      if (blob) await cachePut(cacheKey, blob);
    }

    if (!blob) continue;

    const objUrl = URL.createObjectURL(blob);
    audioEl.src = objUrl;

    // Try to play (may still fail if user never interacted)
    try {
      await audioEl.play();
    } catch (e) {
      // If autoplay is blocked, we stop and show a helpful status
      setStatus("Tap Replay to start audio (iOS autoplay block).");
      URL.revokeObjectURL(objUrl);
      return;
    }

    // Wait for chunk end
    await waitForEnded(audioEl);

    URL.revokeObjectURL(objUrl);
  }

  setStatus("Ready.");
}

async function fetchTtsBlob(ttsUrl, text) {
  try {
    const res = await fetch(ttsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function waitForEnded(aud) {
  return new Promise((resolve) => {
    const done = () => {
      aud.removeEventListener("ended", done);
      aud.removeEventListener("error", done);
      resolve();
    };
    aud.addEventListener("ended", done);
    aud.addEventListener("error", done);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- Worker: story call ----------------
async function callStoryWorker(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error("Worker did not return JSON: " + txt.slice(0, 200)); }

  if (!r.ok) {
    throw new Error(j?.error ? String(j.error) : `HTTP ${r.status}`);
  }
  if (j?.error && !j.story_text) {
    throw new Error(String(j.error));
  }
  return j;
}

// ---------------- Rendering ----------------
function renderStory(text) {
  if (UI.storyText) UI.storyText.textContent = (text || "").trim();
}

function renderChoices(c, choices) {
  if (!UI.choices) return;
  UI.choices.innerHTML = "";

  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No choices returned. Use Continue or Something else.";
    UI.choices.appendChild(d);
    return;
  }

  list.slice(0, 3).forEach((t, i) => {
    const b = document.createElement("button");
    b.className = "choiceBtn";
    b.type = "button";
    b.textContent = `${i + 1}) ${t}`;
    b.onclick = () => advance(c, i + 1, t);
    UI.choices.appendChild(b);
  });
}

// ---------------- Main logic ----------------
async function startNew() {
  playClick();
  await unlockAudioOnce();

  const workerUrl = (UI.workerUrl?.value || "").trim();
  if (!workerUrl) return alert("Enter your Worker URL.");
  const seed = (UI.seed?.value || "").trim();
  if (!seed) return alert("Enter a story seed.");

  const c = {
    id: uuid(),
    name: (UI.campaignName?.value || "").trim() || "Story",
    workerUrl,
    ttsOn: (UI.ttsMode?.value === "on"),
    memoryCapsule: "",
    lastStoryText: "",
    lastChoices: [],
    segments: [],
  };

  setActive(c.id);
  upsertCampaign(c);

  showPlay(c);
  setStatus("Starting...");
  setBusy(true);

  try {
    const r = await callStoryWorker(workerUrl, {
      action: "Begin the story.",
      memory: seed, // seed goes in memory for the start
    });

    c.lastStoryText = r.story_text || r.text || "";
    c.lastChoices = r.choices || [];
    c.memoryCapsule = r.memory_capsule || "";

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      memoryCapsule: c.memoryCapsule,
      choiceTaken: { number: 0, actionText: "START" },
    });

    upsertCampaign(c);

    renderStory(c.lastStoryText);
    renderChoices(c, c.lastChoices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

    setStatus("Ready.");
    // Auto-speak after generation (will work after first user tap)
    await speakWithOpenAiTts(c, c.lastStoryText);
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

async function advance(c, n, actionText) {
  playClick();
  await unlockAudioOnce();

  setStatus("Generating...");
  setBusy(true);
  stopAudio();

  try {
    const r = await callStoryWorker(c.workerUrl, {
      action: actionText,
      memory: c.memoryCapsule || "",
    });

    c.lastStoryText = r.story_text || r.text || "";
    c.lastChoices = r.choices || [];
    c.memoryCapsule = r.memory_capsule || c.memoryCapsule || "";

    c.segments.push({
      at: Date.now(),
      storyText: c.lastStoryText,
      choices: c.lastChoices,
      memoryCapsule: c.memoryCapsule,
      choiceTaken: { number: n, actionText },
    });

    upsertCampaign(c);

    renderStory(c.lastStoryText);
    renderChoices(c, c.lastChoices);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

    setStatus("Ready.");
    await speakWithOpenAiTts(c, c.lastStoryText);
  } catch (e) {
    console.error(e);
    setStatus("Error: " + (e.message || String(e)));
    alert(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

function undo() {
  playClick();
  stopAudio();

  const c = findCampaign(getActive());
  if (!c) return;

  c.segments = c.segments || [];
  if (c.segments.length <= 1) return;

  c.segments.pop();
  const last = c.segments[c.segments.length - 1];

  c.lastStoryText = last?.storyText || "";
  c.lastChoices = last?.choices || [];
  c.memoryCapsule = last?.memoryCapsule || "";

  upsertCampaign(c);

  renderStory(c.lastStoryText);
  renderChoices(c, c.lastChoices);
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

  setStatus("Undid last step.");
}

function loadExisting() {
  playClick();
  stopAudio();

  const list = loadAll();
  if (!list.length) return alert("No campaigns found on this device.");

  const menu = list.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
  const pick = prompt("Pick a campaign:\n\n" + menu);
  const idx = parseInt(pick || "", 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= list.length) return;

  const c = list[idx];
  setActive(c.id);
  showPlay(c);
  renderStory(c.lastStoryText || "");
  renderChoices(c, c.lastChoices || []);
  if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";

  setStatus("Loaded.");
}

function wipeAll() {
  playClick();
  stopAudio();
  if (!confirm("Delete ALL local campaigns on this device?")) return;
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(LS_ACTIVE);
  alert("Local data wiped.");
  showSetup();
}

function goLibrary() {
  playClick();
  stopAudio();
  showSetup();
}

// ---------------- Buttons wiring ----------------
function wireButtons() {
  if (UI.startBtn) UI.startBtn.onclick = startNew;
  if (UI.loadBtn) UI.loadBtn.onclick = loadExisting;
  if (UI.wipeBtn) UI.wipeBtn.onclick = wipeAll;

  if (UI.libraryBtn) UI.libraryBtn.onclick = goLibrary;

  if (UI.undoBtn) UI.undoBtn.onclick = undo;

  if (UI.replayBtn) UI.replayBtn.onclick = async () => {
    playClick();
    await unlockAudioOnce();
    const c = findCampaign(getActive());
    if (!c) return;
    stopAudio();
    await speakWithOpenAiTts(c, c.lastStoryText || "");
  };

  if (UI.pauseBtn) UI.pauseBtn.onclick = () => {
    playClick();
    if (!audioEl) return;
    if (isPaused) resumeAudio();
    else pauseAudio();
  };

  if (UI.stopBtn) UI.stopBtn.onclick = () => {
    playClick();
    stopAudio();
    setStatus("Stopped.");
  };

  if (UI.continueBtn) UI.continueBtn.onclick = () => {
    const c = findCampaign(getActive());
    if (!c) return;
    advance(c, 0, "Continue.");
  };

  if (UI.wildBtn) UI.wildBtn.onclick = () => {
    const c = findCampaign(getActive());
    if (!c) return;
    const t = (UI.wildInput?.value || "").trim();
    if (!t) return alert("Type your action first.");
    if (UI.wildInput) UI.wildInput.value = "";
    advance(c, 0, t);
  };

  // iOS: also unlock audio on any top-level tap, so autoplay becomes reliable
  document.addEventListener("touchend", () => { unlockAudioOnce(); }, { passive: true, once: true });
  document.addEventListener("click", () => { unlockAudioOnce(); }, { passive: true, once: true });
}

// ---------------- Boot ----------------
(function boot() {
  // Restore last used worker URL
  const last = loadAll()[0];
  if (last?.workerUrl && UI.workerUrl) UI.workerUrl.value = last.workerUrl;

  const activeId = getActive();
  const c = activeId ? findCampaign(activeId) : null;

  if (c) {
    showPlay(c);
    renderStory(c.lastStoryText || "");
    renderChoices(c, c.lastChoices || []);
    if (UI.memoryBox) UI.memoryBox.textContent = c.memoryCapsule || "";
    setStatus("Loaded.");
  } else {
    showSetup();
    setStatus("Ready.");
  }

  wireButtons();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
