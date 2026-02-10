/* NES DM Console – dm.js (Phase 1.5)
   Fixes:
   - Targets show names again + can target SELF
   - “Last action” banner on main screen, full log in modal
   - Roster cards align consistently (Focus/HP)
   - Turn progression hardened (can always advance turns)
*/

const $ = (id) => document.getElementById(id);

const UI = {
  systemSelect: $("systemSelect"),
  systemPill: $("systemPill"),
  loadSamplesBtn: $("loadSamplesBtn"),

  pcList: $("pcList"),
  npcList: $("npcList"),
  pcCount: $("pcCount"),
  npcCount: $("npcCount"),

  jsonBox: $("jsonBox"),
  importBtn: $("importBtn"),
  exportBtn: $("exportBtn"),
  wipeBtn: $("wipeBtn"),

  startEncounterBtn: $("startEncounterBtn"),
  rollInitBtn: $("rollInitBtn"),
  endTurnBtn: $("endTurnBtn"),
  nextTurnBtn: $("nextTurnBtn"),

  roundLabel: $("roundLabel"),
  turnLabel: $("turnLabel"),
  activeLabel: $("activeLabel"),
  turnStatus: $("turnStatus"),

  lastActionLine: $("lastActionLine"),
  initHint: $("initHint"),
  initList: $("initList"),

  activeRolePill: $("activeRolePill"),
  activeMeta: $("activeMeta"),

  apPill: $("apPill"),
  apMove: $("apMove"),
  apAction: $("apAction"),
  apBonus: $("apBonus"),
  apReaction: $("apReaction"),

  rollMode: $("rollMode"),
  manualPrimary: $("manualPrimary"),
  manualDefense: $("manualDefense"),

  actions: $("actions"),
  targets: $("targets"),

  advMode: $("advMode"),
  rollMod: $("rollMod"),
  condNote: $("condNote"),
  addCondBtn: $("addCondBtn"),
  clearCondsBtn: $("clearCondsBtn"),
  condList: $("condList"),

  // Log modal
  openLogBtn: $("openLogBtn"),
  closeLogBtn: $("closeLogBtn"),
  logModal: $("logModal"),
  logFull: $("logFull"),
};

const STATE = {
  system: "d20",
  pcs: [],
  npcs: [],
  focusedId: null,

  encounter: {
    started: false,
    round: 0,
    turn: 0,
    status: "—", // Ready / Turn ended
    initOrder: [], // array of char ids
    activeId: null,
    endedThisTurn: false,
    ap: { move: true, action: true, bonus: true, reaction: true },
  },

  log: [], // {id, at, text, snapshot}
  targets: new Set(), // selected target ids
};

function uid() {
  return (crypto.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2));
}

function nowStamp() {
  const d = new Date();
  return d.toLocaleString();
}

function getAllChars() {
  return [...STATE.pcs, ...STATE.npcs];
}

function findChar(id) {
  return getAllChars().find(c => c.id === id) || null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function hpRatio(c) {
  const max = Math.max(1, Number(c.hpMax || c.hp || 0));
  const cur = clamp(Number(c.hp || 0), 0, max);
  return cur / max;
}

function hpClass(c) {
  const r = hpRatio(c);
  if (r <= 0) return "bad";
  if (r < 0.35) return "bad";
  if (r < 0.7) return "warn";
  return "good";
}

function hpBarColorWidth(c) {
  const r = hpRatio(c);
  return Math.round(r * 100);
}

function setLastAction(text) {
  UI.lastActionLine.textContent = text || "—";
}

function pushLog(text) {
  const entry = {
    id: uid(),
    at: Date.now(),
    text,
    snapshot: snapshotState(),
  };
  STATE.log.unshift(entry);
  setLastAction(`${nowStamp()} — ${text}`);
  renderLogModal(); // keep modal fresh
}

function snapshotState() {
  return JSON.parse(JSON.stringify({
    system: STATE.system,
    pcs: STATE.pcs,
    npcs: STATE.npcs,
    focusedId: STATE.focusedId,
    encounter: STATE.encounter,
  }));
}

function restoreSnapshot(snap) {
  STATE.system = snap.system;
  STATE.pcs = snap.pcs;
  STATE.npcs = snap.npcs;
  STATE.focusedId = snap.focusedId;
  STATE.encounter = snap.encounter;
  STATE.targets = new Set();
}

function openLog() {
  UI.logModal.classList.add("show");
  UI.logModal.setAttribute("aria-hidden", "false");
}

function closeLog() {
  UI.logModal.classList.remove("show");
  UI.logModal.setAttribute("aria-hidden", "true");
}

function renderLogModal() {
  if (!UI.logFull) return;
  UI.logFull.innerHTML = "";

  if (!STATE.log.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No log entries yet.";
    UI.logFull.appendChild(d);
    return;
  }

  STATE.log.forEach(e => {
    const box = document.createElement("div");
    box.className = "logEntry";

    const top = document.createElement("div");
    top.className = "logEntryTop";

    const left = document.createElement("div");
    left.className = "muted small";
    left.textContent = new Date(e.at).toLocaleString();

    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Rewind";
    btn.onclick = () => {
      restoreSnapshot(e.snapshot);
      pushLog(`Rewound to: ${e.text}`);
      renderAll();
      closeLog();
    };

    top.appendChild(left);
    top.appendChild(btn);

    const body = document.createElement("div");
    body.style.marginTop = "8px";
    body.textContent = e.text;

    box.appendChild(top);
    box.appendChild(body);
    UI.logFull.appendChild(box);
  });
}

/* ---------- Rendering ---------- */

function renderRoster() {
  UI.systemPill.textContent = STATE.system;

  UI.pcList.innerHTML = "";
  UI.npcList.innerHTML = "";
  UI.pcCount.textContent = String(STATE.pcs.length);
  UI.npcCount.textContent = String(STATE.npcs.length);

  const activeId = STATE.encounter.activeId;

  function makeItem(c) {
    const item = document.createElement("div");
    item.className = "item" + (c.id === activeId ? " active" : "");

    // Left content
    const left = document.createElement("div");
    left.style.minWidth = "0";

    const name = document.createElement("div");
    name.style.fontWeight = "800";
    name.style.whiteSpace = "nowrap";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.textContent = c.name || "Unnamed";

    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent = `${c.role || (c.isNpc ? "NPC" : "PC")}${STATE.system === "d20" ? (c.ac != null ? ` • AC ${c.ac}` : "") : ""}`;

    const hpWrap = document.createElement("div");
    hpWrap.className = "hpWrap";
    hpWrap.style.marginTop = "8px";

    const hpLine = document.createElement("div");
    hpLine.className = "hpLine";
    const hpL = document.createElement("div");
    hpL.textContent = `HP ${c.hp}/${c.hpMax}`;
    const hpP = document.createElement("span");
    hpP.className = "pill " + hpClass(c);
    hpP.textContent = hpClass(c) === "good" ? "OK" : (hpClass(c) === "warn" ? "HURT" : "DOWN");
    hpLine.appendChild(hpL);
    hpLine.appendChild(hpP);

    const barWrap = document.createElement("div");
    barWrap.className = "barWrap";
    const bar = document.createElement("div");
    bar.className = "barFill";
    bar.style.width = hpBarColorWidth(c) + "%";
    bar.style.background = hpClass(c) === "good" ? "#1f6f3f" : (hpClass(c) === "warn" ? "#7a5a12" : "#7a1f2a");
    barWrap.appendChild(bar);

    hpWrap.appendChild(hpLine);
    hpWrap.appendChild(barWrap);

    left.appendChild(name);
    left.appendChild(meta);
    left.appendChild(hpWrap);

    // Right column buttons
    const right = document.createElement("div");
    right.className = "itemRight";

    const focus = document.createElement("button");
    focus.className = "secondary focusBtn";
    focus.textContent = (STATE.focusedId === c.id) ? "Focused" : "Focus";
    focus.onclick = () => {
      STATE.focusedId = c.id;
      if (!STATE.encounter.started) STATE.encounter.activeId = c.id; // allow testing without encounter
      renderAll();
    };

    right.appendChild(focus);

    item.onclick = (ev) => {
      // clicking empty space selects too; ignore button click bubbling
      if (ev.target && ev.target.tagName === "BUTTON") return;
      STATE.focusedId = c.id;
      if (!STATE.encounter.started) STATE.encounter.activeId = c.id;
      renderAll();
    };

    item.appendChild(left);
    item.appendChild(right);
    return item;
  }

  STATE.pcs.forEach(c => UI.pcList.appendChild(makeItem(c)));
  STATE.npcs.forEach(c => UI.npcList.appendChild(makeItem(c)));
}

function renderEncounterHeader() {
  const E = STATE.encounter;

  UI.roundLabel.textContent = E.started ? String(E.round) : "—";
  UI.turnLabel.textContent = E.started ? String(E.turn) : "—";

  const a = E.activeId ? findChar(E.activeId) : null;
  UI.activeLabel.textContent = a ? a.name : "—";

  UI.turnStatus.textContent = E.started ? (E.endedThisTurn ? "Turn ended" : "Ready") : "—";
}

function renderInitList() {
  const E = STATE.encounter;
  if (!E.started || !E.initOrder.length) {
    UI.initList.textContent = "No initiative yet.";
    return;
  }

  const parts = E.initOrder.map((id, idx) => {
    const c = findChar(id);
    if (!c) return "";
    return `${idx === (E.turnIdx || 0) ? "▶ " : ""}${idx + 1}. ${c.name} [${c.hp}/${c.hpMax}]`;
  }).filter(Boolean);

  UI.initList.textContent = parts.join("   ");
}

function setApButtonsVisibilityFromSheet(c) {
  // If no active, hide all
  const show = (btn, on) => { btn.style.display = on ? "" : "none"; };

  if (!c) {
    show(UI.apMove, false); show(UI.apAction, false); show(UI.apBonus, false); show(UI.apReaction, false);
    return;
  }

  // default: show Move + Action always
  const types = new Set((c.actionTypes || ["move","action","bonus","reaction"]).map(x => String(x).toLowerCase()));

  show(UI.apMove, types.has("move"));
  show(UI.apAction, types.has("action"));
  show(UI.apBonus, types.has("bonus"));
  show(UI.apReaction, types.has("reaction"));
}

function renderActivePanel() {
  const E = STATE.encounter;
  const a = E.activeId ? findChar(E.activeId) : null;

  UI.activeRolePill.textContent = a ? (a.isNpc ? "NPC" : "PC") : "—";
  UI.activeMeta.textContent = a ? `${a.name} • ${a.role || (a.isNpc ? "NPC" : "PC")}` : "No active character.";

  setApButtonsVisibilityFromSheet(a);

  // AP pill shows what’s remaining
  if (E.started && a) {
    const left = [];
    if (E.ap.move) left.push("Move");
    if (E.ap.action) left.push("Action");
    if (E.ap.bonus) left.push("Bonus");
    if (E.ap.reaction) left.push("Reaction");
    UI.apPill.textContent = left.length ? left.join(" • ") : "None";
  } else {
    UI.apPill.textContent = "—";
  }

  // Toggle button styles
  const setToggle = (btn, on) => {
    btn.classList.toggle("on", !!on);
  };
  setToggle(UI.apMove, !!E.ap.move);
  setToggle(UI.apAction, !!E.ap.action);
  setToggle(UI.apBonus, !!E.ap.bonus);
  setToggle(UI.apReaction, !!E.ap.reaction);

  // Actions list (from sheet)
  UI.actions.innerHTML = "";
  if (!a) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No active character.";
    UI.actions.appendChild(d);
  } else {
    const acts = Array.isArray(a.actions) ? a.actions : [];
    if (!acts.length) {
      const d = document.createElement("div");
      d.className = "muted";
      d.textContent = "No actions on sheet.";
      UI.actions.appendChild(d);
    } else {
      acts.forEach(act => {
        const b = document.createElement("button");
        b.className = "actionBtn";
        b.type = "button";
        b.textContent = `${(act.type || "action").toUpperCase()}: ${act.name}`;
        b.onclick = () => doAction(a, act);
        UI.actions.appendChild(b);
      });
    }
  }

  // Targets (FIXED names + allow self)
  UI.targets.innerHTML = "";
  if (!a) return;

  const all = getAllChars();

  all.forEach(t => {
    // Allow self target too
    const row = document.createElement("label");
    row.className = "targetRow";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = STATE.targets.has(t.id);
    cb.onchange = () => {
      if (cb.checked) STATE.targets.add(t.id);
      else STATE.targets.delete(t.id);
    };

    const nameWrap = document.createElement("div");
    nameWrap.style.minWidth = "0";

    const nm = document.createElement("div");
    nm.className = "targetName";
    nm.textContent = t.name;

    const mm = document.createElement("div");
    mm.className = "targetMeta";
    mm.textContent = `${t.isNpc ? "NPC" : "PC"} • HP ${t.hp}/${t.hpMax}`;

    nameWrap.appendChild(nm);
    nameWrap.appendChild(mm);

    const badge = document.createElement("span");
    badge.className = "pill " + hpClass(t);
    badge.textContent = t.id === a.id ? "SELF" : (t.isNpc ? "NPC" : "PC");

    row.appendChild(cb);
    row.appendChild(nameWrap);
    row.appendChild(badge);
    UI.targets.appendChild(row);
  });

  // Conditions list
  const conds = Array.isArray(a.conditions) ? a.conditions : [];
  UI.condList.textContent = conds.length ? conds.map(x => `• ${x}`).join("\n") : "—";
}

function renderAll() {
  renderRoster();
  renderEncounterHeader();
  renderInitList();
  renderActivePanel();
}

/* ---------- Combat mechanics (lightweight) ---------- */

function startEncounter() {
  const E = STATE.encounter;
  E.started = true;
  E.round = 1;
  E.turn = 1;
  E.endedThisTurn = false;
  E.turnIdx = 0;
  E.ap = { move: true, action: true, bonus: true, reaction: true };

  // if no initiative yet, build a default order (roster order)
  E.initOrder = getAllChars().map(c => c.id);
  E.activeId = E.initOrder[0] || null;

  STATE.targets = new Set();

  pushLog(`Started encounter (${STATE.system}).`);
  renderAll();
}

function rollInitiative() {
  const E = STATE.encounter;
  if (!E.started) return;

  const chars = getAllChars().map(c => ({ c, init: rollInitFor(c) }));
  chars.sort((a,b) => b.init - a.init);

  E.initOrder = chars.map(x => x.c.id);
  E.turnIdx = 0;
  E.activeId = E.initOrder[0] || null;
  E.turn = 1;
  E.round = 1;
  E.endedThisTurn = false;
  E.ap = { move: true, action: true, bonus: true, reaction: true };
  STATE.targets = new Set();

  const summary = chars.map(x => `${x.c.name} (${x.init})`).join(", ");
  pushLog(`Initiative: ${summary}`);
  renderAll();
}

function rollInitFor(c) {
  if (STATE.system === "d6pool") {
    // simple SR-ish: 1d6 + init
    const base = Number(c.initBase || 7);
    return base + (1 + Math.floor(Math.random()*6));
  }
  // d20: d20 + init
  const mod = Number(c.init || 0);
  return (1 + Math.floor(Math.random()*20)) + mod;
}

function endTurn() {
  const E = STATE.encounter;
  if (!E.started) return;
  E.endedThisTurn = true;
  pushLog(`End Turn: ${findChar(E.activeId)?.name || "—"}`);
  renderAll();
}

function nextTurn() {
  const E = STATE.encounter;
  if (!E.started || !E.initOrder.length) return;

  // If user forgot to End Turn, we still allow progress (prevents “stuck”)
  if (!E.endedThisTurn) {
    pushLog(`Auto-ended turn for: ${findChar(E.activeId)?.name || "—"}`);
  }

  E.turnIdx = (E.turnIdx ?? 0) + 1;

  if (E.turnIdx >= E.initOrder.length) {
    E.turnIdx = 0;
    E.round += 1;
  }

  E.turn += 1;
  E.activeId = E.initOrder[E.turnIdx] || null;
  E.endedThisTurn = false;
  E.ap = { move: true, action: true, bonus: true, reaction: true };
  STATE.targets = new Set();

  pushLog(`Next Turn: ${findChar(E.activeId)?.name || "—"} (Round ${E.round})`);
  renderAll();
}

function spendAP(kind) {
  const E = STATE.encounter;
  if (!E.started) return;
  if (E.ap[kind] === false) return;
  E.ap[kind] = false;
  renderAll();
}

/* ---------- Actions / Rolls ---------- */

function doAction(actor, act) {
  // Spend matching AP if encounter is running
  const t = String(act.type || "action").toLowerCase();
  if (t === "move") spendAP("move");
  if (t === "action") spendAP("action");
  if (t === "bonus") spendAP("bonus");
  if (t === "reaction") spendAP("reaction");

  const targets = Array.from(STATE.targets).map(id => findChar(id)).filter(Boolean);
  const tgtNames = targets.length ? targets.map(x => x.name).join(", ") : "—";

  // Roll (very basic placeholder — you’ll replace this with AI/real sheet logic later)
  const rollMode = UI.rollMode.value;
  const primary = rollMode === "manual" ? UI.manualPrimary.value.trim() : autoPrimaryRoll(actor, act);
  const defense = rollMode === "manual" ? UI.manualDefense.value.trim() : "";

  pushLog(`Action: ${actor.name} uses ${act.name} → Targets: ${tgtNames}\nRoll: ${primary}${defense ? ` vs ${defense}` : ""}`);

  // clear manual fields after using
  UI.manualPrimary.value = "";
  UI.manualDefense.value = "";
}

function autoPrimaryRoll(actor, act) {
  if (STATE.system === "d6pool") {
    // simple: pool dice hits
    const pool = Number(act.pool || actor.pool || 8);
    const hits = rollD6Hits(pool);
    return `${hits} hits (${pool}d6)`;
  }

  // d20: d20 + toHit
  const toHit = Number(act.toHit ?? actor.toHit ?? 0);
  const d20 = 1 + Math.floor(Math.random()*20);
  const total = d20 + toHit;
  return `${total} (d20=${d20}${toHit ? (toHit>0 ? `+${toHit}` : `${toHit}`) : ""})`;
}

function rollD6Hits(n) {
  let hits = 0;
  for (let i=0;i<n;i++) {
    const d = 1 + Math.floor(Math.random()*6);
    if (d >= 5) hits++;
  }
  return hits;
}

/* ---------- Import/Export/Wipe ---------- */

function exportJSON() {
  const all = getAllChars();
  UI.jsonBox.value = JSON.stringify(all, null, 2);
}

function importJSON() {
  const txt = UI.jsonBox.value.trim();
  if (!txt) return alert("Paste JSON first.");
  let arr;
  try { arr = JSON.parse(txt); } catch { return alert("Invalid JSON."); }
  if (!Array.isArray(arr)) return alert("JSON must be an array.");

  // split by isNpc
  STATE.pcs = arr.filter(x => !x.isNpc);
  STATE.npcs = arr.filter(x => !!x.isNpc);

  pushLog(`Imported ${arr.length} characters.`);
  renderAll();
}

function wipeSession() {
  if (!confirm("Wipe session (roster + encounter + log)?")) return;

  STATE.pcs = [];
  STATE.npcs = [];
  STATE.focusedId = null;
  STATE.targets = new Set();
  STATE.log = [];
  STATE.encounter = {
    started: false, round: 0, turn: 0, status: "—",
    initOrder: [], activeId: null, endedThisTurn: false,
    ap: { move: true, action: true, bonus: true, reaction: true },
  };

  setLastAction("—");
  renderAll();
}

/* ---------- Samples ---------- */

function loadSamples() {
  if (STATE.system === "d6pool") {
    // Shadowrun-ish test pack (2 PCs + 2 NPCs)
    STATE.pcs = [
      {
        id: uid(), isNpc:false,
        name:"Jax 'Wires' Moreno", role:"Street Samurai",
        hp: 11, hpMax: 11, initBase: 9,
        actionTypes:["move","action","reaction","bonus"],
        actions:[
          { type:"action", name:"Burst Fire (SMG)", pool: 12 },
          { type:"action", name:"Melee Strike", pool: 10 },
          { type:"reaction", name:"Full Defense", pool: 8 },
        ],
        conditions:[]
      },
      {
        id: uid(), isNpc:false,
        name:"Nyx Kincaid", role:"Mage",
        hp: 9, hpMax: 9, initBase: 7,
        actionTypes:["move","action","reaction"],
        actions:[
          { type:"action", name:"Manabolt", pool: 11 },
          { type:"action", name:"Stunbolt", pool: 10 },
          { type:"reaction", name:"Counterspelling", pool: 9 },
        ],
        conditions:[]
      },
    ];
    STATE.npcs = [
      {
        id: uid(), isNpc:true,
        name:"Go-Gang Thug", role:"Ganger",
        hp: 8, hpMax: 8, initBase: 6,
        actionTypes:["move","action","reaction"],
        actions:[
          { type:"action", name:"Pistol Shot", pool: 8 },
          { type:"action", name:"Knife Jab", pool: 7 },
        ],
        conditions:[]
      },
      {
        id: uid(), isNpc:true,
        name:"Security Drone", role:"Drone",
        hp: 10, hpMax: 10, initBase: 8,
        actionTypes:["move","action","reaction"],
        actions:[
          { type:"action", name:"Suppressive Fire", pool: 9 },
          { type:"reaction", name:"Evasive Maneuvers", pool: 7 },
        ],
        conditions:[]
      },
    ];

    pushLog("Loaded d6 pool sample pack (4 characters).");
    renderAll();
    return;
  }

  // d20 pack (2 PCs + 2 NPCs)
  STATE.pcs = [
    {
      id: uid(), isNpc:false,
      name:"Thorin Ironhand", role:"Fighter",
      hp: 28, hpMax: 28, ac: 17, init: 2, toHit: 6,
      actionTypes:["move","action","bonus","reaction"],
      actions:[
        { type:"action", name:"Longsword", toHit: 6 },
        { type:"action", name:"Javelin", toHit: 5 },
        { type:"bonus", name:"Second Wind" },
        { type:"reaction", name:"Opportunity Attack", toHit: 6 },
      ],
      conditions:[]
    },
    {
      id: uid(), isNpc:false,
      name:"Elowen Vale", role:"Wizard",
      hp: 18, hpMax: 18, ac: 13, init: 1, toHit: 5,
      actionTypes:["move","action","reaction"],
      actions:[
        { type:"action", name:"Fire Bolt", toHit: 5 },
        { type:"action", name:"Magic Missile" },
        { type:"reaction", name:"Shield" },
      ],
      conditions:[]
    },
  ];

  STATE.npcs = [
    {
      id: uid(), isNpc:true,
      name:"Goblin Skirmisher", role:"Skirmisher",
      hp: 12, hpMax: 12, ac: 13, init: 2, toHit: 4,
      actionTypes:["move","action","bonus","reaction"],
      actions:[
        { type:"action", name:"Scimitar", toHit: 4 },
        { type:"action", name:"Shortbow", toHit: 4 },
        { type:"bonus", name:"Nimble Escape" },
        { type:"reaction", name:"Opportunity Attack", toHit: 4 },
      ],
      conditions:[]
    },
    {
      id: uid(), isNpc:true,
      name:"Orc Brute", role:"Brute",
      hp: 30, hpMax: 30, ac: 13, init: 0, toHit: 5,
      actionTypes:["move","action","reaction"],
      actions:[
        { type:"action", name:"Greataxe", toHit: 5 },
        { type:"reaction", name:"Opportunity Attack", toHit: 5 },
      ],
      conditions:[]
    },
  ];

  pushLog("Loaded d20 sample pack (4 characters).");
  renderAll();
}

/* ---------- Conditions ---------- */

function addCondition() {
  const a = STATE.encounter.activeId ? findChar(STATE.encounter.activeId) : null;
  if (!a) return;

  const adv = UI.advMode.value;
  const mod = UI.rollMod.value.trim();
  const note = UI.condNote.value.trim();

  const parts = [];
  if (adv === "adv") parts.push("Advantage");
  if (adv === "dis") parts.push("Disadvantage");
  if (mod) parts.push(`Mod ${mod}`);
  if (note) parts.push(note);

  if (!parts.length) return;

  a.conditions = Array.isArray(a.conditions) ? a.conditions : [];
  a.conditions.push(parts.join(" • "));

  UI.rollMod.value = "";
  UI.condNote.value = "";
  UI.advMode.value = "none";

  pushLog(`Condition added to ${a.name}: ${parts.join(" • ")}`);
  renderAll();
}

function clearConditions() {
  const a = STATE.encounter.activeId ? findChar(STATE.encounter.activeId) : null;
  if (!a) return;
  a.conditions = [];
  pushLog(`Cleared conditions on ${a.name}.`);
  renderAll();
}

/* ---------- Wire UI ---------- */

function boot() {
  UI.systemSelect.value = STATE.system;

  UI.systemSelect.onchange = () => {
    STATE.system = UI.systemSelect.value;
    STATE.pcs = [];
    STATE.npcs = [];
    STATE.focusedId = null;
    STATE.targets = new Set();
    STATE.encounter.started = false;
    STATE.encounter.initOrder = [];
    STATE.encounter.activeId = null;
    STATE.encounter.round = 0;
    STATE.encounter.turn = 0;
    STATE.encounter.turnIdx = 0;
    STATE.encounter.endedThisTurn = false;
    setLastAction("—");
    pushLog(`System set to ${STATE.system}.`);
    renderAll();
  };

  UI.loadSamplesBtn.onclick = loadSamples;

  UI.importBtn.onclick = importJSON;
  UI.exportBtn.onclick = exportJSON;
  UI.wipeBtn.onclick = wipeSession;

  UI.startEncounterBtn.onclick = startEncounter;
  UI.rollInitBtn.onclick = rollInitiative;
  UI.endTurnBtn.onclick = endTurn;
  UI.nextTurnBtn.onclick = nextTurn;

  UI.apMove.onclick = () => spendAP("move");
  UI.apAction.onclick = () => spendAP("action");
  UI.apBonus.onclick = () => spendAP("bonus");
  UI.apReaction.onclick = () => spendAP("reaction");

  UI.addCondBtn.onclick = addCondition;
  UI.clearCondsBtn.onclick = clearConditions;

  UI.openLogBtn.onclick = openLog;
  UI.closeLogBtn.onclick = closeLog;

  // click outside modal card closes
  UI.logModal.addEventListener("click", (e) => {
    if (e.target === UI.logModal) closeLog();
  });

  setLastAction("—");
  renderAll();
}

boot();
