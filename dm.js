/* NES DM Console – dm.js (Phase 1.4)
   Fixes:
   - Roster alignment (stable name/HP/focus layout)
   - Targets missing names on iOS Safari (use <span> inside <label>)
   - Allow targeting self (protective spells etc.)
   - Main view log trimmed; full log only in Log View
   - Log View button only shows when selected (Back), main shows “Open Log View” link
*/

const LS_KEY = "nes_dm_session_v4";
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

  openLogViewBtn: el("openLogViewBtn"),
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

let S = loadState() || freshState();

function freshState() {
  return {
    system: "d20",
    chars: [],
    encounter: {
      started: false,
      initRolled: false,
      round: 1,
      turnIndex: 0,
      order: [],
      activeId: null,
      spent: {},
      done: {},
    },
    ui: {
      focusedId: null,
      selectedTargetIds: [],
    },
    conds: {
      advMode: "none",
      rollMod: "",
      notes: [],
    },
    log: [], // newest first
  };
}

function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY) || ""); } catch { return null; } }
function uid() { return (crypto.randomUUID?.() || Math.random().toString(16).slice(2) + Date.now().toString(16)); }
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

function setStatus(msg) { UI.turnStatus.textContent = msg || "—"; }

function getChar(id) { return S.chars.find(c => c.id === id) || null; }
function pcs() { return S.chars.filter(c => c.role === "pc" && c.system === S.system); }
function npcs() { return S.chars.filter(c => c.role === "npc" && c.system === S.system); }

function encounterActive() {
  return !!S.encounter.started && !!S.encounter.initRolled && S.encounter.order.length > 0;
}

function currentActive() {
  return S.encounter.activeId ? getChar(S.encounter.activeId) : null;
}

function ensureSpentFor(id) {
  if (!S.encounter.spent[id]) S.encounter.spent[id] = { move: true, action: true, bonus: true, reaction: true };
  if (S.encounter.done[id] === undefined) S.encounter.done[id] = false;
}

function resetTurnFor(id) {
  ensureSpentFor(id);
  S.encounter.spent[id] = { move: true, action: true, bonus: true, reaction: true };
  S.encounter.done[id] = false;
  S.ui.selectedTargetIds = [];
}

function pillForHp(cur, max) {
  if (max <= 0) return "pill";
  const pct = Math.max(0, Math.min(1, cur / max));
  if (pct <= 0) return "pill bad";
  if (pct < 0.35) return "pill bad";
  if (pct < 0.7) return "pill warn";
  return "pill good";
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

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

function rewindTo(entryId) {
  const e = S.log.find(x => x.id === entryId);
  if (!e) return;

  const snap = deepClone(e.snapshot);
  S.system = snap.system;
  S.chars = snap.chars;
  S.encounter = snap.encounter;
  S.ui = snap.ui;
  S.conds = snap.conds;

  // truncate newer entries
  const idx = S.log.findIndex(x => x.id === entryId);
  if (idx >= 0) S.log = S.log.slice(idx);

  saveState();
  renderAll();
  setStatus("Rewound.");
}

// ---------------- Samples ----------------
function samplePack(system) {
  if (system === "d20") {
    return [
      { id: uid(), system:"d20", role:"pc", name:"Thorin Ironhand", hp:{cur:28,max:28},
        sheet:{ class:"Fighter", ac:17, speed:30,
          actions:[{id:"a1",type:"action",name:"Longsword",kind:"attack",attackBonus:5,damage:"1d8+3"}],
          bonus:[{id:"b1",type:"bonus",name:"Second Wind",kind:"utility",text:"Heal 1d10+lvl"}],
          reaction:[{id:"r1",type:"reaction",name:"Opportunity Attack",kind:"attack",attackBonus:5,damage:"1d8+3"}],
        }
      },
      { id: uid(), system:"d20", role:"pc", name:"Elowen Vale", hp:{cur:18,max:18},
        sheet:{ class:"Wizard", ac:13, speed:30,
          actions:[
            {id:"a1",type:"action",name:"Fire Bolt",kind:"attack",attackBonus:5,damage:"1d10"},
            {id:"a2",type:"action",name:"Magic Missile",kind:"attack",alwaysHits:true,damage:"3*(1d4+1)"},
          ],
          bonus:[],
          reaction:[{id:"r1",type:"reaction",name:"Shield (spell)",kind:"utility",text:"+5 AC"}],
        }
      },
      { id: uid(), system:"d20", role:"npc", name:"Goblin Skirmisher", hp:{cur:12,max:12},
        sheet:{ class:"Skirmisher", ac:13, speed:30,
          actions:[
            {id:"a1",type:"action",name:"Scimitar",kind:"attack",attackBonus:4,damage:"1d6+2"},
            {id:"a2",type:"action",name:"Shortbow",kind:"attack",attackBonus:4,damage:"1d6+2"},
          ],
          bonus:[], reaction:[]
        }
      },
      { id: uid(), system:"d20", role:"npc", name:"Orc Brute", hp:{cur:30,max:30},
        sheet:{ class:"Brute", ac:13, speed:30,
          actions:[{id:"a1",type:"action",name:"Greataxe",kind:"attack",attackBonus:5,damage:"1d12+3"}],
          bonus:[], reaction:[]
        }
      },
    ];
  }

  return [
    { id: uid(), system:"d6pool", role:"pc", name:"Kara Ironoak", hp:{cur:10,max:10},
      sheet:{ archetype:"Street Samurai", move:10, pools:{attack:12,defense:10,soak:12},
        actions:[{id:"a1",type:"action",name:"Ares Predator",kind:"opposed",attackPool:12,baseDamage:8}],
        bonus:[], reaction:[]
      }
    },
    { id: uid(), system:"d6pool", role:"pc", name:"Jinx Calder", hp:{cur:10,max:10},
      sheet:{ archetype:"Decker", move:10, pools:{attack:8,defense:9,soak:8},
        actions:[{id:"a1",type:"action",name:"Light Pistol",kind:"opposed",attackPool:8,baseDamage:6}],
        bonus:[], reaction:[]
      }
    },
    { id: uid(), system:"d6pool", role:"npc", name:"Ganger", hp:{cur:8,max:8},
      sheet:{ archetype:"Thug", move:10, pools:{attack:7,defense:7,soak:6},
        actions:[{id:"a1",type:"action",name:"Knife",kind:"opposed",attackPool:7,baseDamage:5}],
        bonus:[], reaction:[]
      }
    },
    { id: uid(), system:"d6pool", role:"npc", name:"Security Guard", hp:{cur:9,max:9},
      sheet:{ archetype:"Security", move:10, pools:{attack:8,defense:8,soak:8},
        actions:[{id:"a1",type:"action",name:"SMG Burst",kind:"opposed",attackPool:9,baseDamage:7}],
        bonus:[], reaction:[]
      }
    },
  ];
}

// ---------------- Rolling helpers ----------------
function rollD20() { return 1 + Math.floor(Math.random() * 20); }

function parseSignedInt(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  const n = parseInt(t.replace("+", ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function rollXdY(x, y) {
  let total = 0;
  for (let i = 0; i < x; i++) total += 1 + Math.floor(Math.random() * y);
  return total;
}

function rollDiceExpr(expr) {
  const t = String(expr || "").trim();
  if (!t) return 0;

  const m = t.match(/^(\d+)\s*\*\s*\(\s*(\d+)d(\d+)(\s*([+-])\s*(\d+))?\s*\)\s*$/i);
  if (m) {
    const mult = parseInt(m[1], 10);
    const count = parseInt(m[2], 10);
    const sides = parseInt(m[3], 10);
    const sign = m[5] || "+";
    const add = parseInt(m[6] || "0", 10);
    let total = 0;
    for (let i = 0; i < mult; i++) total += rollXdY(count, sides) + (sign === "-" ? -add : add);
    return total;
  }

  const m2 = t.match(/^(\d+)d(\d+)(\s*([+-])\s*(\d+))?$/i);
  if (m2) {
    const count = parseInt(m2[1], 10);
    const sides = parseInt(m2[2], 10);
    const sign = m2[4] || "+";
    const add = parseInt(m2[5] || "0", 10);
    return rollXdY(count, sides) + (sign === "-" ? -add : add);
  }

  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

function rollD6Hits(pool) {
  let hits = 0, ones = 0;
  for (let i = 0; i < pool; i++) {
    const d = 1 + Math.floor(Math.random() * 6);
    if (d >= 5) hits++;
    if (d === 1) ones++;
  }
  const glitch = (ones >= Math.ceil(pool / 2)) && (hits === 0);
  const minorGlitch = (ones >= Math.ceil(pool / 2)) && (hits > 0);
  return { hits, glitch, minorGlitch };
}

// ---------------- Encounter ----------------
function startEncounter() {
  S.encounter.started = true;
  S.encounter.initRolled = false;
  S.encounter.round = 1;
  S.encounter.turnIndex = 0;
  S.encounter.order = [];
  S.encounter.activeId = null;
  S.encounter.spent = {};
  S.encounter.done = {};
  S.ui.selectedTargetIds = [];
  addLog(`Started encounter (${S.system}).`);
}

function rollInitiative() {
  const list = S.chars.filter(c => c.system === S.system);
  if (!list.length) return;

  const order = list.map(c => {
    if (S.system === "d20") {
      const bonus = parseInt(c.sheet?.initBonus || "0", 10) || 0;
      const r = rollD20();
      return { id: c.id, score: r + bonus, detail: `${r}${bonus ? (bonus > 0 ? `+${bonus}` : `${bonus}`) : ""}` };
    } else {
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

  for (const id of S.encounter.order) resetTurnFor(id);

  addLog(`Initiative: ${order.map(x => `${getChar(x.id)?.name || "?"} (${x.detail})`).join(", ")}`);
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

  const order = S.encounter.order;
  if (!order.length) return;

  let idx = S.encounter.turnIndex + 1;
  if (idx >= order.length) {
    idx = 0;
    S.encounter.round += 1;
    for (const id of order) S.encounter.done[id] = false;
    addLog(`— Round ${S.encounter.round} —`);
  }

  S.encounter.turnIndex = idx;
  S.encounter.activeId = order[idx];
  resetTurnFor(S.encounter.activeId);

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
  const out = [];
  (c?.sheet?.actions || []).forEach(x => out.push(x));
  (c?.sheet?.bonus || []).forEach(x => out.push(x));
  (c?.sheet?.reaction || []).forEach(x => out.push(x));
  return out;
}

// ---------------- Action resolution ----------------
function setSelectedTarget(id, on) {
  const set = new Set(S.ui.selectedTargetIds || []);
  if (on) set.add(id);
  else set.delete(id);
  S.ui.selectedTargetIds = Array.from(set);
  saveState();
  renderTargets();
}

function selectedTargets() {
  return (S.ui.selectedTargetIds || []).map(id => getChar(id)).filter(Boolean);
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

  const apType = action.type;
  const ok = consumeAP(apType);
  if (!ok) {
    addLog(`⚠️ ${c.name} has no ${apType.toUpperCase()} left.`);
    return;
  }

  const mode = UI.rollMode.value || "auto";
  const targets = selectedTargets();

  // For attacks/opposed, need at least one target
  if ((action.kind === "attack" || action.kind === "opposed") && targets.length < 1) {
    addLog(`⚠️ Select at least 1 target for ${action.name}.`);
    S.encounter.spent[c.id][apType] = true; // refund
    saveState();
    renderAll();
    return;
  }

  // For utility, allow no target OR self target (your choice)
  // (We’ll just log and do nothing for now.)
  if (action.kind === "utility" && targets.length < 1) {
    addLog(`${c.name} uses ${action.name}. (No target selected)`);
    saveState();
    renderAll();
    return;
  }

  if (S.system === "d20") {
    const t = targets[0];
    const adv = UI.advMode.value || "none";
    const mod = parseSignedInt(UI.rollMod.value);

    if (action.alwaysHits) {
      const dmg = mode === "manual"
        ? (parseInt(UI.manualPrimary.value || "0", 10) || rollDiceExpr(action.damage))
        : rollDiceExpr(action.damage);

      applyDamage(t.id, dmg);
      addLog(`${c.name} uses ${action.name} on ${t.name} (auto-hit) for ${dmg} dmg. (${t.hp.cur}/${t.hp.max})`);
      saveState(); renderAll(); return;
    }

    const attackBonus = (action.attackBonus ?? 0) + mod;

    let total, raw;
    if (mode === "manual") {
      total = parseInt(String(UI.manualPrimary.value || "").trim(), 10);
      if (!Number.isFinite(total)) total = 0;
      raw = `manual ${total}`;
    } else {
      const r1 = rollD20();
      const r2 = rollD20();
      let r = r1;
      if (adv === "adv") r = Math.max(r1, r2);
      if (adv === "dis") r = Math.min(r1, r2);
      total = r + attackBonus;
      raw = adv === "none" ? `${r}` : `${r} (from ${r1},${r2})`;
    }

    const ac = parseInt(t.sheet?.ac || "10", 10) || 10;
    const hit = total >= ac;

    if (!hit) {
      addLog(`${c.name} → ${action.name} vs ${t.name}: ${raw}${attackBonus ? ` +${attackBonus}` : ""} = ${total} vs AC ${ac} → MISS`);
      saveState(); renderAll(); return;
    }

    const dmg = mode === "manual"
      ? (parseInt(UI.manualDefense.value || "0", 10) || rollDiceExpr(action.damage))
      : rollDiceExpr(action.damage);

    applyDamage(t.id, dmg);
    addLog(`${c.name} → ${action.name} hits ${t.name}: ${raw}${attackBonus ? ` +${attackBonus}` : ""} = ${total} vs AC ${ac} → ${dmg} dmg. (${t.hp.cur}/${t.hp.max})`);
    saveState(); renderAll(); return;
  }

  // d6pool
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
      atkHits = a.hits; defHits = d.hits;
      if (a.glitch) flags += " ⚠️ GLITCH(attacker)";
      else if (a.minorGlitch) flags += " ⚠️ Minor glitch(attacker)";
      if (d.glitch) flags += " ⚠️ GLITCH(defender)";
      else if (d.minorGlitch) flags += " ⚠️ Minor glitch(defender)";
    }

    const net = Math.max(0, atkHits - defHits);
    const base = parseInt(action.baseDamage || 0, 10) || 0;
    const dmg = base + net;

    applyDamage(t.id, dmg);
    addLog(`${c.name} → ${action.name} vs ${t.name}: atk ${atkHits} vs def ${defHits} → net ${net}, dmg ${dmg}.${flags} (${t.hp.cur}/${t.hp.max})`);
    saveState(); renderAll(); return;
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

    // Name + HP pill aligned as grid to stop drift
    const top = document.createElement("div");
    top.style.display = "grid";
    top.style.gridTemplateColumns = "minmax(0,1fr) auto";
    top.style.alignItems = "center";
    top.style.gap = "10px";

    const name = document.createElement("b");
    name.textContent = c.name;
    name.style.minWidth = "0";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    name.style.whiteSpace = "nowrap";

    const hpPill = document.createElement("span");
    hpPill.className = pillForHp(c.hp.cur, c.hp.max);
    hpPill.textContent = `HP ${c.hp.cur}/${c.hp.max}`;

    top.appendChild(name);
    top.appendChild(hpPill);

    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent = S.system === "d20"
      ? `${c.sheet?.class || "—"} • AC ${c.sheet?.ac ?? "—"}`
      : `${c.sheet?.archetype || "—"} • Def ${c.sheet?.pools?.defense ?? "—"}`;

    left.appendChild(top);
    left.appendChild(meta);

    const right = document.createElement("div");
    const focus = document.createElement("button");
    focus.className = "secondary";
    focus.textContent = "Focus";
    focus.onclick = () => { S.ui.focusedId = c.id; saveState(); renderAll(); };
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

  const isLogOnly = document.body.classList.contains("logOnly");
  const limit = isLogOnly ? 200 : 6; // main view “essential only”

  const slice = S.log.slice(0, limit);

  for (const e of slice) {
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
    btn.textContent = "Rewind";
    btn.onclick = () => rewindTo(e.id);

    header.appendChild(left);
    header.appendChild(btn);

    const body = document.createElement("div");
    body.textContent = e.text;

    d.appendChild(header);
    d.appendChild(body);
    UI.log.appendChild(d);
  }

  if (!isLogOnly && S.log.length > limit) {
    const more = document.createElement("div");
    more.className = "muted small";
    more.textContent = `Showing last ${limit} events. Use “Open Log View” for full history.`;
    UI.log.appendChild(more);
  }
}

function setToggle(btn, on) { if (btn) btn.classList.toggle("on", !!on); }

function renderActivePanel() {
  const c = encounterActive() ? currentActive() : (S.ui.focusedId ? getChar(S.ui.focusedId) : null);

  if (!c) {
    UI.activeRolePill.textContent = "—";
    UI.activeMeta.textContent = "No active character.";
    UI.actions.innerHTML = "";
    UI.targets.innerHTML = "";
    UI.apPill.textContent = "—";
    return;
  }

  UI.activeRolePill.textContent = c.role.toUpperCase();
  UI.activeMeta.textContent = `${c.name} • ${S.system === "d20" ? (c.sheet?.class || "—") : (c.sheet?.archetype || "—")}`;

  const types = actionTypesForChar(c);

  UI.apMove.style.display = types.hasMove ? "" : "none";
  UI.apAction.style.display = types.hasAction ? "" : "none";
  UI.apBonus.style.display = types.hasBonus ? "" : "none";
  UI.apReaction.style.display = types.hasReaction ? "" : "none";

  ensureSpentFor(c.id);
  const s = S.encounter.spent[c.id];

  setToggle(UI.apMove, s.move);
  setToggle(UI.apAction, s.action);
  setToggle(UI.apBonus, s.bonus);
  setToggle(UI.apReaction, s.reaction);

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
    b.onclick = () => resolveAction(a);
    UI.actions.appendChild(b);
  }
}

function renderTargets() {
  UI.targets.innerHTML = "";

  const c = encounterActive() ? currentActive() : null;
  if (!encounterActive() || !c) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Start encounter + initiative to select targets.";
    UI.targets.appendChild(d);
    return;
  }

  const orderChars = S.encounter.order.map(id => getChar(id)).filter(Boolean);

  // allow self-targeting
  const selfRow = makeTargetRow(c, true, "Self (You)");
  UI.targets.appendChild(selfRow);

  // everyone else
  for (const t of orderChars) {
    if (t.id === c.id) continue;
    UI.targets.appendChild(makeTargetRow(t, false));
  }

  function makeTargetRow(t, isSelf, forcedLabel) {
    const row = document.createElement("div");
    row.className = "targetRow";

    const lab = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (S.ui.selectedTargetIds || []).includes(t.id);
    cb.onchange = () => setSelectedTarget(t.id, cb.checked);

    const name = document.createElement("span"); // SAFARI FRIENDLY
    name.className = "name";
    const label = forcedLabel || t.name;
    name.textContent = `${label} (${t.hp.cur}/${t.hp.max})`;

    const hp = document.createElement("span");
    hp.className = pillForHp(t.hp.cur, t.hp.max);
    hp.textContent = "HP";

    lab.appendChild(cb);
    lab.appendChild(name);

    row.appendChild(lab);
    row.appendChild(hp);

    return row;
  }
}

function renderConds() {
  UI.condList.textContent = (S.conds.notes || []).length
    ? S.conds.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "—";
}

function renderAll() {
  UI.systemPill.textContent = S.system;
  UI.systemSelect.value = S.system;

  renderRoster();
  renderInit();
  renderLog();
  renderActivePanel();

  UI.startEncounterBtn.disabled = (S.chars.filter(c => c.system === S.system).length < 1);
  UI.rollInitBtn.disabled = !S.encounter.started;
  UI.endTurnBtn.disabled = !encounterActive();
  UI.nextTurnBtn.disabled = !encounterActive();
}

// ---------------- Import/Export/Wipe ----------------
function importChars() {
  let arr;
  try { arr = JSON.parse(UI.jsonBox.value || "[]"); } catch { alert("Invalid JSON"); return; }
  if (!Array.isArray(arr)) return alert("Paste a JSON array.");

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

  S.chars = S.chars.filter(c => c.system !== S.system).concat(cleaned.filter(c => c.system === S.system));
  addLog(`Imported ${cleaned.filter(c => c.system === S.system).length} characters for ${S.system}.`);
}

function exportChars() {
  const list = S.chars.filter(c => c.system === S.system);
  UI.jsonBox.value = JSON.stringify(list, null, 2);
}

function wipeSession() {
  if (!confirm("Wipe ALL DM session data?")) return;
  S = freshState();
  saveState();
  renderAll();
  setStatus("Wiped.");
}

// ---------------- Log view toggles ----------------
function openLogView() {
  document.body.classList.add("logOnly");
  saveState();
  renderAll();
}
function backFromLogView() {
  document.body.classList.remove("logOnly");
  saveState();
  renderAll();
}

// ---------------- Boot ----------------
function boot() {
  if (!S.system) S.system = "d20";
  if (!S.encounter) S.encounter = freshState().encounter;

  UI.systemSelect.onchange = () => { S.system = UI.systemSelect.value; S.ui.focusedId = null; saveState(); renderAll(); };

  UI.loadSamplesBtn.onclick = () => {
    const pack = samplePack(S.system);
    S.chars = S.chars.filter(c => c.system !== S.system).concat(pack);
    addLog(`Loaded ${S.system} sample pack (${pack.length} chars).`);
  };

  UI.importBtn.onclick = importChars;
  UI.exportBtn.onclick = exportChars;
  UI.wipeBtn.onclick = wipeSession;

  UI.startEncounterBtn.onclick = startEncounter;
  UI.rollInitBtn.onclick = rollInitiative;
  UI.endTurnBtn.onclick = endTurn;
  UI.nextTurnBtn.onclick = nextTurn;

  UI.openLogViewBtn && (UI.openLogViewBtn.onclick = openLogView);
  UI.toggleLogViewBtn && (UI.toggleLogViewBtn.onclick = backFromLogView);

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

  // AP toggles (manual override for now)
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

  // keep log view state if already set
  // (do nothing if not)
  renderAll();
  setStatus("Ready.");
}

boot();
