/* NES DM Console – dm.js (Phase 1.3)
   Fixes:
   - Next Turn lock: Next Turn is always allowed when encounter is active (no “stuck” state)
   - Rewind restores full encounter runtime state
   - Targets never overflow the box (rows only, no absolute positioning)
   - Active character highlight (roster + init list)
   - HP tracking w/ green/yellow/red pills
   - Action-type buttons auto-hide if not on the sheet
*/

const LS_KEY = "nes_dm_session_v3";

const el = (id) => document.getElementById(id);

const UI = {
  systemPill: el("systemPill"),
  systemSelect: el("systemSelect"),
  loadSamplesBtn: el("loadSamplesBtn"),

  pcCount: el("pcCount"),
  npcCount: el("npcCount"),
  pcList: el("pcList"),
  npcList: el("npcList"),

  jsonBox: el("jsonBox"),
  importBtn: el("importBtn"),
  exportBtn: el("exportBtn"),
  wipeBtn: el("wipeBtn"),

  toggleLogViewBtn: el("toggleLogViewBtn"),

  startEncounterBtn: el("startEncounterBtn"),
  rollInitBtn: el("rollInitBtn"),
  endTurnBtn: el("endTurnBtn"),
  nextTurnBtn: el("nextTurnBtn"),

  roundLabel: el("roundLabel"),
  turnLabel: el("turnLabel"),
  activeLabel: el("activeLabel"),
  turnStatus: el("turnStatus"),

  initHint: el("initHint"),
  initList: el("initList"),
  log: el("log"),

  activeRolePill: el("activeRolePill"),
  activeMeta: el("activeMeta"),
  apPill: el("apPill"),
  apMove: el("apMove"),
  apAction: el("apAction"),
  apBonus: el("apBonus"),
  apReaction: el("apReaction"),

  rollMode: el("rollMode"),
  manualPrimary: el("manualPrimary"),
  manualDefense: el("manualDefense"),

  actions: el("actions"),
  targets: el("targets"),

  advMode: el("advMode"),
  rollMod: el("rollMod"),
  condNote: el("condNote"),
  addCondBtn: el("addCondBtn"),
  clearCondsBtn: el("clearCondsBtn"),
  condList: el("condList"),

  libraryBtn: el("libraryBtn"),
};

// ---------------- State ----------------
let S = loadState() || freshState();

function freshState() {
  return {
    system: "d20",
    chars: [], // {id,name,role,system,hp:{cur,max},sheet:{...}}
    encounter: {
      started: false,
      initRolled: false,
      round: 1,
      turnIndex: 0,
      order: [],      // array of charIds
      activeId: null,
      spent: {},      // { [charId]: {move:true/false, action:true/false, bonus:true/false, reaction:true/false} }
      done: {},       // { [charId]: true/false } "turn ended" marker
    },
    ui: {
      focusedId: null,
      selectedActionId: null,
      selectedTargetIds: [],
    },
    conds: {
      // active character conditions only for Phase 1
      advMode: "none",
      rollMod: "",
      notes: [],
    },
    log: [], // {id,at,text,snapshot}
  };
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(S));
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || ""); } catch { return null; }
}
function uid() {
  return (crypto.randomUUID?.() || Math.random().toString(16).slice(2) + Date.now().toString(16));
}
function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------- Utilities ----------------
function setStatus(msg) {
  UI.turnStatus.textContent = msg || "—";
}
function pillForHp(cur, max) {
  if (max <= 0) return "pill";
  const pct = Math.max(0, Math.min(1, cur / max));
  if (pct <= 0) return "pill bad";
  if (pct < 0.35) return "pill bad";
  if (pct < 0.7) return "pill warn";
  return "pill good";
}

function getChar(id) {
  return S.chars.find(c => c.id === id) || null;
}
function pcs() { return S.chars.filter(c => c.role === "pc" && c.system === S.system); }
function npcs() { return S.chars.filter(c => c.role === "npc" && c.system === S.system); }

function encounterActive() {
  return !!S.encounter.started && !!S.encounter.initRolled && S.encounter.order.length > 0;
}

function ensureSpentFor(id) {
  if (!S.encounter.spent[id]) {
    S.encounter.spent[id] = { move: true, action: true, bonus: true, reaction: true };
  }
  if (S.encounter.done[id] === undefined) {
    S.encounter.done[id] = false;
  }
}

function resetTurnFor(id) {
  ensureSpentFor(id);
  S.encounter.spent[id] = { move: true, action: true, bonus: true, reaction: true };
  S.encounter.done[id] = false;
  S.ui.selectedActionId = null;
  S.ui.selectedTargetIds = [];
}

function currentActive() {
  return S.encounter.activeId ? getChar(S.encounter.activeId) : null;
}

// ---------------- Samples ----------------
function samplePack(system) {
  if (system === "d20") {
    return [
      {
        id: uid(),
        system: "d20",
        role: "pc",
        name: "Thorin Ironhand",
        hp: { cur: 28, max: 28 },
        sheet: {
          class: "Fighter",
          ac: 17,
          speed: 30,
          actions: [
            { id: "a1", type: "action", name: "Longsword", kind: "attack", attackBonus: 5, damage: "1d8+3" },
            { id: "a2", type: "action", name: "Light Crossbow", kind: "attack", attackBonus: 3, damage: "1d8+1" },
          ],
          bonus: [
            { id: "b1", type: "bonus", name: "Second Wind", kind: "utility", text: "Heal 1d10+lvl (test: heal 6)" },
          ],
          reaction: [
            { id: "r1", type: "reaction", name: "Opportunity Attack", kind: "attack", attackBonus: 5, damage: "1d8+3" },
          ],
        },
      },
      {
        id: uid(),
        system: "d20",
        role: "pc",
        name: "Elowen Vale",
        hp: { cur: 18, max: 18 },
        sheet: {
          class: "Wizard",
          ac: 13,
          speed: 30,
          actions: [
            { id: "a1", type: "action", name: "Fire Bolt", kind: "attack", attackBonus: 5, damage: "1d10" },
            { id: "a2", type: "action", name: "Magic Missile", kind: "attack", attackBonus: null, damage: "3*(1d4+1)", alwaysHits: true },
          ],
          bonus: [],
          reaction: [
            { id: "r1", type: "reaction", name: "Shield (spell)", kind: "utility", text: "+5 AC until start of next turn" },
          ],
        },
      },
      {
        id: uid(),
        system: "d20",
        role: "npc",
        name: "Goblin Skirmisher",
        hp: { cur: 12, max: 12 },
        sheet: {
          class: "Skirmisher",
          ac: 13,
          speed: 30,
          actions: [
            { id: "a1", type: "action", name: "Scimitar", kind: "attack", attackBonus: 4, damage: "1d6+2" },
            { id: "a2", type: "action", name: "Shortbow", kind: "attack", attackBonus: 4, damage: "1d6+2" },
          ],
          bonus: [],
          reaction: [],
        },
      },
      {
        id: uid(),
        system: "d20",
        role: "npc",
        name: "Orc Brute",
        hp: { cur: 30, max: 30 },
        sheet: {
          class: "Brute",
          ac: 13,
          speed: 30,
          actions: [
            { id: "a1", type: "action", name: "Greataxe", kind: "attack", attackBonus: 5, damage: "1d12+3" },
          ],
          bonus: [],
          reaction: [],
        },
      },
    ];
  }

  // d6pool (Shadowrun-like)
  return [
    {
      id: uid(),
      system: "d6pool",
      role: "pc",
      name: "Kara Ironoak",
      hp: { cur: 10, max: 10 }, // physical track (simplified)
      sheet: {
        archetype: "Street Samurai",
        move: 10,
        pools: { attack: 12, defense: 10, soak: 12 },
        actions: [
          { id: "a1", type: "action", name: "Ares Predator (Pistol)", kind: "opposed", attackPool: 12, baseDamage: 8 },
          { id: "a2", type: "action", name: "Katana", kind: "opposed", attackPool: 11, baseDamage: 9 },
        ],
        bonus: [],
        reaction: [],
      },
    },
    {
      id: uid(),
      system: "d6pool",
      role: "pc",
      name: "Jinx Calder",
      hp: { cur: 10, max: 10 },
      sheet: {
        archetype: "Decker",
        move: 10,
        pools: { attack: 8, defense: 9, soak: 8 },
        actions: [
          { id: "a1", type: "action", name: "Light Pistol", kind: "opposed", attackPool: 8, baseDamage: 6 },
          { id: "a2", type: "action", name: "Taser (nonlethal)", kind: "opposed", attackPool: 8, baseDamage: 5 },
        ],
        bonus: [],
        reaction: [],
      },
    },
    {
      id: uid(),
      system: "d6pool",
      role: "npc",
      name: "Ganger",
      hp: { cur: 8, max: 8 },
      sheet: {
        archetype: "Thug",
        move: 10,
        pools: { attack: 7, defense: 7, soak: 6 },
        actions: [
          { id: "a1", type: "action", name: "Knife", kind: "opposed", attackPool: 7, baseDamage: 5 },
        ],
        bonus: [],
        reaction: [],
      },
    },
    {
      id: uid(),
      system: "d6pool",
      role: "npc",
      name: "Security Guard",
      hp: { cur: 9, max: 9 },
      sheet: {
        archetype: "Security",
        move: 10,
        pools: { attack: 8, defense: 8, soak: 8 },
        actions: [
          { id: "a1", type: "action", name: "SMG Burst", kind: "opposed", attackPool: 9, baseDamage: 7 },
        ],
        bonus: [],
        reaction: [],
      },
    },
  ];
}

// ---------------- Rolling ----------------
function rollD20() {
  return 1 + Math.floor(Math.random() * 20);
}
function parseSignedInt(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? n : 0;
}
function rollDiceExpr(expr) {
  // very small parser for common patterns: "1d8+3" / "1d10" / "3*(1d4+1)"
  const t = String(expr || "").trim();
  if (!t) return 0;

  // handle multiplier "N*(XdY+Z)"
  const m = t.match(/^(\d+)\s*\*\s*\(\s*(\d+)d(\d+)(\s*([+-])\s*(\d+))?\s*\)\s*$/i);
  if (m) {
    const mult = parseInt(m[1], 10);
    const count = parseInt(m[2], 10);
    const sides = parseInt(m[3], 10);
    const sign = m[5] || "+";
    const add = parseInt(m[6] || "0", 10);
    let total = 0;
    for (let i = 0; i < mult; i++) {
      total += rollXdY(count, sides) + (sign === "-" ? -add : add);
    }
    return total;
  }

  // basic "XdY+Z"
  const m2 = t.match(/^(\d+)d(\d+)(\s*([+-])\s*(\d+))?$/i);
  if (m2) {
    const count = parseInt(m2[1], 10);
    const sides = parseInt(m2[2], 10);
    const sign = m2[4] || "+";
    const add = parseInt(m2[5] || "0", 10);
    const base = rollXdY(count, sides);
    return base + (sign === "-" ? -add : add);
  }

  // fallback numeric
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}
function rollXdY(x, y) {
  let total = 0;
  for (let i = 0; i < x; i++) total += 1 + Math.floor(Math.random() * y);
  return total;
}
function rollD6Hits(pool) {
  let hits = 0;
  let ones = 0;
  for (let i = 0; i < pool; i++) {
    const d = 1 + Math.floor(Math.random() * 6);
    if (d >= 5) hits++;
    if (d === 1) ones++;
  }
  const glitch = (ones >= Math.ceil(pool / 2)) && (hits === 0);
  const minorGlitch = (ones >= Math.ceil(pool / 2)) && (hits > 0);
  return { hits, glitch, minorGlitch };
}

// ---------------- Log + Snapshot + Rewind ----------------
function addLog(text) {
  const entry = {
    id: uid(),
    at: Date.now(),
    text: String(text || ""),
    snapshot: deepClone({
      system: S.system,
      chars: S.chars,
      encounter: S.encounter,
      ui: S.ui,
      conds: S.conds,
    }),
  };
  S.log.unshift(entry);
  saveState();
  renderAll();
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}
function rewindTo(entryId) {
  const e = S.log.find(x => x.id === entryId);
  if (!e) return;
  const snap = deepClone(e.snapshot);

  // restore
  S.system = snap.system;
  S.chars = snap.chars;
  S.encounter = snap.encounter;
  S.ui = snap.ui;
  S.conds = snap.conds;

  // truncate log to this point (everything after is invalid now)
  const idx = S.log.findIndex(x => x.id === entryId);
  if (idx >= 0) S.log = S.log.slice(idx); // keep this and older (since log is newest-first)
  saveState();
  renderAll();
  setStatus("Rewound.");
}

// ---------------- Encounter ----------------
function startEncounter() {
  // encounter exists but no init until roll
  S.encounter.started = true;
  S.encounter.initRolled = false;
  S.encounter.round = 1;
  S.encounter.turnIndex = 0;
  S.encounter.order = [];
  S.encounter.activeId = null;
  S.encounter.spent = {};
  S.encounter.done = {};
  S.ui.selectedActionId = null;
  S.ui.selectedTargetIds = [];
  addLog(`Started encounter (${S.system}).`);
}

function rollInitiative() {
  const list = S.chars.filter(c => c.system === S.system);
  if (list.length < 1) return;

  const order = list.map(c => {
    if (S.system === "d20") {
      const bonus = parseInt(c.sheet?.initBonus || "0", 10) || 0;
      const roll = rollD20();
      return { id: c.id, score: roll + bonus, detail: `${roll}${bonus ? (bonus > 0 ? `+${bonus}` : `${bonus}`) : ""}` };
    } else {
      // simple: use defense pool as initiative proxy (placeholder)
      const pool = parseInt(c.sheet?.pools?.defense || "6", 10) || 6;
      const r = rollD6Hits(pool);
      return { id: c.id, score: r.hits, detail: `${r.hits} hits` };
    }
  });

  order.sort((a, b) => b.score - a.score);

  S.encounter.order = order.map(x => x.id);
  S.encounter.initRolled = true;
  S.encounter.turnIndex = 0;
  S.encounter.activeId = S.encounter.order[0] || null;

  // reset turn spend for everyone
  for (const id of S.encounter.order) resetTurnFor(id);

  addLog(`Rolled initiative. Order: ${order.map(x => `${getChar(x.id)?.name || "?"} (${x.detail})`).join(", ")}`);
}

function endTurn() {
  if (!encounterActive()) return;
  const id = S.encounter.activeId;
  if (!id) return;

  S.encounter.done[id] = true;
  addLog(`End Turn: ${getChar(id)?.name || "Unknown"}`);
  setStatus("Turn ended.");
}

function nextTurn() {
  if (!encounterActive()) return;

  // Always advance even if “done” wasn’t clicked (prevents lockups)
  const order = S.encounter.order;
  if (!order.length) return;

  let idx = S.encounter.turnIndex;
  idx++;

  if (idx >= order.length) {
    idx = 0;
    S.encounter.round += 1;
    // new round resets “done” (but we do NOT reset reaction globally; you can later decide)
    for (const id of order) S.encounter.done[id] = false;
    addLog(`— New Round ${S.encounter.round} —`);
  }

  S.encounter.turnIndex = idx;
  S.encounter.activeId = order[idx];

  // reset spend for new active
  resetTurnFor(S.encounter.activeId);

  // clear UI selections
  S.ui.selectedActionId = null;
  S.ui.selectedTargetIds = [];

  addLog(`Next Turn: ${getChar(S.encounter.activeId)?.name || "Unknown"}`);
}

// ---------------- Sheet-driven availability ----------------
function actionTypesForChar(c) {
  const speed = c?.sheet?.speed || c?.sheet?.move || 0;
  const hasMove = !!speed;

  const actions = (c?.sheet?.actions || []).filter(x => x.type === "action");
  const bonus = (c?.sheet?.bonus || []).filter(x => x.type === "bonus");
  const reaction = (c?.sheet?.reaction || []).filter(x => x.type === "reaction");

  return {
    hasMove,
    hasAction: actions.length > 0,
    hasBonus: bonus.length > 0,
    hasReaction: reaction.length > 0,
  };
}

function listActionsForChar(c) {
  const a = [];
  (c?.sheet?.actions || []).forEach(x => a.push(x));
  (c?.sheet?.bonus || []).forEach(x => a.push(x));
  (c?.sheet?.reaction || []).forEach(x => a.push(x));
  return a;
}

// ---------------- Action resolution ----------------
function selectedTargets() {
  return (S.ui.selectedTargetIds || []).map(id => getChar(id)).filter(Boolean);
}
function setSelectedTarget(id, on) {
  const set = new Set(S.ui.selectedTargetIds || []);
  if (on) set.add(id);
  else set.delete(id);
  S.ui.selectedTargetIds = Array.from(set);
  saveState();
  renderTargets();
}

function consumeAP(type) {
  const id = S.encounter.activeId;
  if (!id) return false;
  ensureSpentFor(id);
  if (!S.encounter.spent[id][type]) return false;
  S.encounter.spent[id][type] = false;
  return true;
}

function applyDamage(targetId, dmg) {
  const t = getChar(targetId);
  if (!t) return;
  t.hp.cur = Math.max(0, (t.hp.cur || 0) - dmg);
}

function resolveAction(action) {
  const c = currentActive();
  if (!c) return;

  // enforce AP spend only if that type exists on sheet
  const apType = action.type; // action / bonus / reaction
  const canSpend = consumeAP(apType);
  if (!canSpend) {
    addLog(`⚠️ ${c.name} has no ${apType.toUpperCase()} left. End Turn or choose another available type.`);
    return;
  }

  const mode = UI.rollMode.value || "auto";
  const targets = selectedTargets();

  // require at least 1 target for attack/opposed actions
  if ((action.kind === "attack" || action.kind === "opposed") && targets.length < 1) {
    addLog(`⚠️ Select at least 1 target for ${action.name}.`);
    // refund AP (since it wasn't actually used)
    S.encounter.spent[c.id][apType] = true;
    saveState();
    renderAll();
    return;
  }

  // d20 system
  if (S.system === "d20") {
    // for simplicity: resolve against first target only (multi-target later)
    const t = targets[0];
    const adv = UI.advMode.value || "none";
    const mod = parseSignedInt(UI.rollMod.value);

    if (action.alwaysHits) {
      const dmg = mode === "manual"
        ? (parseInt(UI.manualPrimary.value || "0", 10) || rollDiceExpr(action.damage))
        : rollDiceExpr(action.damage);
      applyDamage(t.id, dmg);
      addLog(`${c.name} uses ${action.name} (auto-hit) on ${t.name} for ${dmg} dmg. (${t.hp.cur}/${t.hp.max} HP)`);
      saveState();
      renderAll();
      return;
    }

    const attackBonus = (action.attackBonus ?? 0) + mod;

    let attackRollTotal;
    let rawRollText = "";

    if (mode === "manual") {
      attackRollTotal = parseInt(String(UI.manualPrimary.value || "").trim(), 10);
      if (!Number.isFinite(attackRollTotal)) attackRollTotal = 0;
      rawRollText = `manual ${attackRollTotal}`;
    } else {
      let r1 = rollD20();
      let r2 = rollD20();
      let r = r1;
      if (adv === "adv") r = Math.max(r1, r2);
      if (adv === "dis") r = Math.min(r1, r2);
      attackRollTotal = r + attackBonus;
      rawRollText = adv === "none" ? `${r}` : `${r} (from ${r1},${r2})`;
    }

    const targetAC = parseInt(t.sheet?.ac || "10", 10) || 10;
    const hit = attackRollTotal >= targetAC;

    if (!hit) {
      addLog(`${c.name} attacks with ${action.name} vs ${t.name}: roll ${rawRollText}${attackBonus ? ` + ${attackBonus}` : ""} = ${attackRollTotal} vs AC ${targetAC} → MISS`);
      saveState();
      renderAll();
      return;
    }

    const dmg = mode === "manual"
      ? (parseInt(UI.manualDefense.value || "0", 10) || rollDiceExpr(action.damage))
      : rollDiceExpr(action.damage);

    applyDamage(t.id, dmg);
    addLog(`${c.name} hits ${t.name} with ${action.name}: roll ${rawRollText}${attackBonus ? ` + ${attackBonus}` : ""} = ${attackRollTotal} vs AC ${targetAC} → HIT for ${dmg} dmg. (${t.hp.cur}/${t.hp.max} HP)`);
    saveState();
    renderAll();
    return;
  }

  // d6pool opposed system
  if (S.system === "d6pool") {
    const t = targets[0];
    const atkPool = parseInt(action.attackPool || c.sheet?.pools?.attack || 6, 10) || 6;
    const defPool = parseInt(t.sheet?.pools?.defense || 6, 10) || 6;

    let atkHits, defHits, flags = "";
    if (mode === "manual") {
      atkHits = parseInt(UI.manualPrimary.value || "0", 10) || 0;
      defHits = parseInt(UI.manualDefense.value || "0", 10) || 0;
    } else {
      const a = rollD6Hits(atkPool);
      const d = rollD6Hits(defPool);
      atkHits = a.hits;
      defHits = d.hits;
      if (a.glitch) flags += " ⚠️ GLITCH(attacker)";
      else if (a.minorGlitch) flags += " ⚠️ Minor glitch(attacker)";
      if (d.glitch) flags += " ⚠️ GLITCH(defender)";
      else if (d.minorGlitch) flags += " ⚠️ Minor glitch(defender)";
    }

    const net = Math.max(0, atkHits - defHits);
    const base = parseInt(action.baseDamage || 0, 10) || 0;
    const dmg = base + net;

    applyDamage(t.id, dmg);
    addLog(`${c.name} uses ${action.name} vs ${t.name}: atk ${atkHits} hits vs def ${defHits} hits → net ${net}, dmg ${dmg}.${flags} (${t.hp.cur}/${t.hp.max} track)`);
    saveState();
    renderAll();
    return;
  }
}

// ---------------- Rendering ----------------
function renderRoster() {
  const pcsList = pcs();
  const npcsList = npcs();
  UI.pcCount.textContent = String(pcsList.length);
  UI.npcCount.textContent = String(npcsList.length);

  UI.pcList.innerHTML = "";
  UI.npcList.innerHTML = "";

  const activeId = S.encounter.activeId;

  function renderOne(c) {
    const div = document.createElement("div");
    div.className = "item" + (c.id === activeId ? " active" : "");
    const left = document.createElement("div");
    left.style.minWidth = "0";

    const title = document.createElement("div");
    title.style.display = "flex";
    title.style.justifyContent = "space-between";
    title.style.gap = "8px";

    const name = document.createElement("b");
    name.textContent = c.name;

    const hpPill = document.createElement("span");
    hpPill.className = pillForHp(c.hp.cur, c.hp.max);
    hpPill.textContent = `HP ${c.hp.cur}/${c.hp.max}`;

    title.appendChild(name);
    title.appendChild(hpPill);

    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent = S.system === "d20"
      ? `${c.sheet?.class || "—"} • AC ${c.sheet?.ac ?? "—"}`
      : `${c.sheet?.archetype || "—"} • Def ${c.sheet?.pools?.defense ?? "—"}`;

    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement("div");
    const focus = document.createElement("button");
    focus.className = "secondary";
    focus.textContent = "Focus";
    focus.onclick = () => {
      S.ui.focusedId = c.id;
      saveState();
      renderAll();
    };
    right.appendChild(focus);

    div.appendChild(left);
    div.appendChild(right);
    return div;
  }

  pcsList.forEach(c => UI.pcList.appendChild(renderOne(c)));
  npcsList.forEach(c => UI.npcList.appendChild(renderOne(c)));
}

function renderInit() {
  if (!encounterActive()) {
    UI.initList.textContent = "No initiative yet.";
    UI.roundLabel.textContent = "—";
    UI.turnLabel.textContent = "—";
    UI.activeLabel.textContent = "—";
    return;
  }

  UI.roundLabel.textContent = String(S.encounter.round);
  UI.turnLabel.textContent = String(S.encounter.turnIndex + 1);
  UI.activeLabel.textContent = currentActive()?.name || "—";

  const rows = S.encounter.order.map((id, idx) => {
    const c = getChar(id);
    const active = (id === S.encounter.activeId);
    const done = !!S.encounter.done[id];
    const hp = c ? `${c.hp.cur}/${c.hp.max}` : "—";
    const marker = active ? "▶ " : "  ";
    const doneTag = done ? " (done)" : "";
    return `${marker}${idx + 1}. ${c?.name || "?"} [${hp}]${doneTag}`;
  });

  UI.initList.textContent = rows.join("\n");
}

function renderLog() {
  UI.log.innerHTML = "";
  for (const e of S.log) {
    const d = document.createElement("div");
    d.className = "logEntry";

    const header = document.createElement("div");
    header.className = "row";
    header.style.justifyContent = "space-between";

    const left = document.createElement("div");
    left.className = "muted small";
    left.textContent = fmtTime(e.at);

    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Rewind here";
    btn.onclick = () => rewindTo(e.id);

    header.appendChild(left);
    header.appendChild(btn);

    const body = document.createElement("div");
    body.textContent = e.text;

    d.appendChild(header);
    d.appendChild(body);
    UI.log.appendChild(d);
  }
}

function renderActivePanel() {
  const c = encounterActive() ? currentActive() : (S.ui.focusedId ? getChar(S.ui.focusedId) : null);

  if (!c) {
    UI.activeRolePill.textContent = "—";
    UI.activeMeta.textContent = "No active character.";
    UI.actions.innerHTML = "";
    UI.targets.innerHTML = "";
    UI.apPill.textContent = "—";
    setStatus(encounterActive() ? "Ready." : "Load/Start an encounter.");
    return;
  }

  UI.activeRolePill.textContent = c.role.toUpperCase();
  UI.activeMeta.textContent = `${c.name} • ${S.system === "d20" ? (c.sheet?.class || "—") : (c.sheet?.archetype || "—")}`;

  // action-type availability (sheet-driven)
  const types = actionTypesForChar(c);

  // show/hide AP buttons
  UI.apMove.style.display = types.hasMove ? "" : "none";
  UI.apAction.style.display = types.hasAction ? "" : "none";
  UI.apBonus.style.display = types.hasBonus ? "" : "none";
  UI.apReaction.style.display = types.hasReaction ? "" : "none";

  ensureSpentFor(c.id);

  // set toggle states
  setToggle(UI.apMove, S.encounter.spent[c.id]?.move);
  setToggle(UI.apAction, S.encounter.spent[c.id]?.action);
  setToggle(UI.apBonus, S.encounter.spent[c.id]?.bonus);
  setToggle(UI.apReaction, S.encounter.spent[c.id]?.reaction);

  // AP pill summary
  const s = S.encounter.spent[c.id];
  const parts = [];
  if (types.hasMove) parts.push(s.move ? "Move" : "Move✖");
  if (types.hasAction) parts.push(s.action ? "Action" : "Action✖");
  if (types.hasBonus) parts.push(s.bonus ? "Bonus" : "Bonus✖");
  if (types.hasReaction) parts.push(s.reaction ? "React" : "React✖");
  UI.apPill.textContent = parts.length ? parts.join(" • ") : "No sheet actions";

  renderActions();
  renderTargets();
  renderConds();
}

function setToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
}

function renderActions() {
  const c = encounterActive() ? currentActive() : (S.ui.focusedId ? getChar(S.ui.focusedId) : null);
  UI.actions.innerHTML = "";
  if (!c) return;

  const list = listActionsForChar(c);
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No actions on sheet.";
    UI.actions.appendChild(d);
    return;
  }

  for (const a of list) {
    const b = document.createElement("button");
    b.className = "secondary actionBtn";
    b.textContent = `${a.type.toUpperCase()}: ${a.name}`;
    b.onclick = () => {
      S.ui.selectedActionId = a.id;
      saveState();
      renderAll();
      // execute immediately (Phase 1 behavior)
      resolveAction(a);
    };
    UI.actions.appendChild(b);
  }
}

function renderTargets() {
  const c = encounterActive() ? currentActive() : null;
  UI.targets.innerHTML = "";

  if (!encounterActive() || !c) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Start encounter + roll initiative to select targets.";
    UI.targets.appendChild(d);
    return;
  }

  const others = S.encounter.order
    .map(id => getChar(id))
    .filter(x => x && x.id !== c.id);

  if (!others.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No valid targets.";
    UI.targets.appendChild(d);
    return;
  }

  for (const t of others) {
    const row = document.createElement("div");
    row.className = "targetRow";

    const lab = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (S.ui.selectedTargetIds || []).includes(t.id);
    cb.onchange = () => setSelectedTarget(t.id, cb.checked);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${t.name} (${t.hp.cur}/${t.hp.max})`;

    const hp = document.createElement("span");
    hp.className = pillForHp(t.hp.cur, t.hp.max);
    hp.textContent = "HP";

    lab.appendChild(cb);
    lab.appendChild(name);

    row.appendChild(lab);
    row.appendChild(hp);

    UI.targets.appendChild(row);
  }
}

function renderConds() {
  UI.condList.textContent = (S.conds.notes || []).length
    ? S.conds.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "—";
}

// ---------------- Import/Export/Wipe ----------------
function importChars() {
  let arr;
  try { arr = JSON.parse(UI.jsonBox.value || "[]"); } catch {
    alert("Invalid JSON");
    return;
  }
  if (!Array.isArray(arr)) return alert("Paste a JSON array.");

  // normalize
  const cleaned = arr
    .filter(x => x && typeof x === "object")
    .map(x => ({
      id: x.id || uid(),
      system: x.system || S.system,
      role: (x.role === "npc" ? "npc" : "pc"),
      name: x.name || "Unnamed",
      hp: x.hp && typeof x.hp === "object"
        ? { cur: Number(x.hp.cur ?? x.hp.max ?? 1), max: Number(x.hp.max ?? 1) }
        : { cur: 10, max: 10 },
      sheet: x.sheet || {},
    }));

  // merge (replace for that system)
  S.chars = S.chars.filter(c => c.system !== S.system).concat(cleaned.filter(c => c.system === S.system));
  addLog(`Imported ${cleaned.filter(c => c.system === S.system).length} characters for ${S.system}.`);
}

function exportChars() {
  const list = S.chars.filter(c => c.system === S.system);
  UI.jsonBox.value = JSON.stringify(list, null, 2);
}

function wipeSession() {
  if (!confirm("Wipe ALL DM session data (both systems, encounter, log)?")) return;
  S = freshState();
  saveState();
  renderAll();
  setStatus("Wiped.");
}

// ---------------- Render All ----------------
function renderAll() {
  UI.systemPill.textContent = S.system;
  UI.systemSelect.value = S.system;

  renderRoster();
  renderInit();
  renderLog();
  renderActivePanel();

  // button enabling
  UI.startEncounterBtn.disabled = (S.chars.filter(c => c.system === S.system).length < 1);
  UI.rollInitBtn.disabled = !S.encounter.started;
  UI.endTurnBtn.disabled = !encounterActive();
  UI.nextTurnBtn.disabled = !encounterActive(); // allowed whenever encounterActive (never locked by action state)
}

function setSystem(v) {
  S.system = v;
  // clear focus to avoid confusion between systems
  S.ui.focusedId = null;
  saveState();
  renderAll();
}

function toggleLogView() {
  document.body.classList.toggle("logOnly");
  saveState();
}

// ---------------- Wire up ----------------
function boot() {
  // ensure defaults if older session existed
  if (!S.system) S.system = "d20";
  if (!S.encounter) S.encounter = freshState().encounter;

  UI.systemSelect.onchange = () => setSystem(UI.systemSelect.value);
  UI.loadSamplesBtn.onclick = () => {
    const pack = samplePack(S.system);
    S.chars = S.chars.filter(c => c.system !== S.system).concat(pack);
    addLog(`Loaded ${S.system} sample pack (${pack.length} characters).`);
  };

  UI.importBtn.onclick = importChars;
  UI.exportBtn.onclick = exportChars;
  UI.wipeBtn.onclick = wipeSession;

  UI.startEncounterBtn.onclick = startEncounter;
  UI.rollInitBtn.onclick = rollInitiative;

  UI.endTurnBtn.onclick = endTurn;
  UI.nextTurnBtn.onclick = nextTurn;

  UI.toggleLogViewBtn.onclick = toggleLogView;

  // Conditions
  UI.addCondBtn.onclick = () => {
    const t = String(UI.condNote.value || "").trim();
    if (!t) return;
    S.conds.notes = S.conds.notes || [];
    S.conds.notes.push(t);
    UI.condNote.value = "";
    saveState();
    renderConds();
  };
  UI.clearCondsBtn.onclick = () => {
    S.conds.notes = [];
    saveState();
    renderConds();
  };

  // AP buttons are indicators in Phase 1; we keep them clickable as a manual override for testing
  function toggleSpent(key) {
    const c = currentActive();
    if (!c) return;
    ensureSpentFor(c.id);
    S.encounter.spent[c.id][key] = !S.encounter.spent[c.id][key];
    saveState();
    renderActivePanel();
  }
  UI.apMove.onclick = () => toggleSpent("move");
  UI.apAction.onclick = () => toggleSpent("action");
  UI.apBonus.onclick = () => toggleSpent("bonus");
  UI.apReaction.onclick = () => toggleSpent("reaction");

  UI.libraryBtn.onclick = () => {
    // just a placeholder hook for later
    addLog("Roster button clicked.");
  };

  renderAll();
  setStatus("Ready.");
}

boot();
