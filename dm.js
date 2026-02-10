/* NES DM Console – dm.js (Phase 1.6)
   Fixes:
   - Target names missing (renders name + HP)
   - Allows SELF targeting
   - Attacks apply damage to targets (HP changes immediately)
   - Main screen shows only last-action banner; full log is modal
   - Prevents "Next Turn locked after NPC action" by keeping turn state consistent
   - Keeps 4 sample chars per system (2 PC + 2 NPC)
*/

const LS_DM_STATE = "nes_dm_state_v16";

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

  initList: $("initList"),
  initHint: $("initHint"),

  lastActionText: $("lastActionText"),
  openLogBtn: $("openLogBtn"),
  closeLogBtn: $("closeLogBtn"),
  logBack: $("logBack"),
  logList: $("logList"),

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

  libraryBtn: $("libraryBtn"),
};

function nowTs() { return Date.now(); }
function uid() { return crypto.randomUUID(); }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function saveState() { localStorage.setItem(LS_DM_STATE, JSON.stringify(state)); }
function loadState() { return safeJsonParse(localStorage.getItem(LS_DM_STATE) || "", null); }

/* -----------------------------
   State model
-------------------------------- */
let state = loadState() || {
  system: "d20",
  characters: [], // {id,name,role:pc|npc, class, hp:{cur,max}, ac, init, sheet:{actions, move}, sr:{tracks}, conds:[]}
  encounter: {
    active: false,
    round: 0,
    turn: 0,
    order: [],   // list of character ids
    activeId: null,
    ap: { move:true, action:true, bonus:true, reaction:true },
    log: [],     // {id,at,text,snapshot}
    lastText: "Last Action: —",
  },
};

function getChar(id) { return state.characters.find(c => c.id === id) || null; }
function pcs() { return state.characters.filter(c => c.role === "pc"); }
function npcs() { return state.characters.filter(c => c.role === "npc"); }

function activeChar() {
  const id = state.encounter.activeId;
  return id ? getChar(id) : null;
}

/* -----------------------------
   Dice helpers
-------------------------------- */
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rollD20() { return randInt(1, 20); }
function rollD6() { return randInt(1, 6); }

function parseMod(modStr) {
  const s = String(modStr || "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const m = s.match(/([+-]?\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// very small dice parser: "2d6+3", "1d8", "10"
function rollDiceExpr(expr) {
  const s = String(expr || "").trim().toLowerCase();
  if (!s) return { total: 0, detail: "0" };

  if (/^\d+$/.test(s)) {
    const v = parseInt(s, 10);
    return { total: v, detail: String(v) };
  }

  const m = s.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return { total: 0, detail: `0 (bad expr: ${expr})` };

  const n = parseInt(m[1], 10);
  const die = parseInt(m[2], 10);
  const add = m[3] ? parseInt(m[3], 10) : 0;
  let sum = 0;
  const rolls = [];
  for (let i = 0; i < n; i++) {
    const r = randInt(1, die);
    rolls.push(r);
    sum += r;
  }
  sum += add;
  const detail = `${rolls.join("+")}${add ? (add > 0 ? `+${add}` : `${add}`) : ""}`;
  return { total: sum, detail };
}

function applyAdvantage(baseRoll, advMode) {
  if (advMode === "adv") return Math.max(baseRoll, rollD20());
  if (advMode === "dis") return Math.min(baseRoll, rollD20());
  return baseRoll;
}

function hpState(c) {
  const cur = c?.hp?.cur ?? 0;
  const max = c?.hp?.max ?? 0;
  const pct = max > 0 ? (cur / max) : 0;
  if (cur <= 0) return { label: "DOWN", cls: "bad", pct: 0 };
  if (pct <= 0.35) return { label: "BAD", cls: "bad", pct };
  if (pct <= 0.70) return { label: "HURT", cls: "warn", pct };
  return { label: "OK", cls: "good", pct };
}

/* -----------------------------
   UI rendering
-------------------------------- */
function setModal(open) {
  UI.logBack.style.display = open ? "flex" : "none";
  UI.logBack.setAttribute("aria-hidden", open ? "false" : "true");
}

function renderSystem() {
  UI.systemSelect.value = state.system;
  UI.systemPill.textContent = state.system === "d20" ? "d20" : "d6pool";
}

function renderRoster() {
  UI.pcList.innerHTML = "";
  UI.npcList.innerHTML = "";
  UI.pcCount.textContent = String(pcs().length);
  UI.npcCount.textContent = String(npcs().length);

  const activeId = state.encounter.activeId;

  function makeCard(c) {
    const wrap = document.createElement("div");
    wrap.className = "item" + (c.id === activeId ? " active" : "");

    const left = document.createElement("div");
    left.className = "itemLeft";

    const nameLine = document.createElement("div");
    nameLine.className = "nameLine";

    const nm = document.createElement("div");
    nm.className = "charName";
    nm.textContent = c.name;

    const roleP = document.createElement("span");
    roleP.className = "pill " + (c.role === "pc" ? "good" : "warn");
    roleP.textContent = c.role.toUpperCase();

    nameLine.appendChild(nm);
    nameLine.appendChild(roleP);

    const sub = document.createElement("div");
    sub.className = "subLine";
    const cls = document.createElement("span");
    cls.className = "mini";
    cls.textContent = c.class ? c.class : (c.role === "npc" ? "NPC" : "PC");
    sub.appendChild(cls);

    const stats = document.createElement("div");
    stats.className = "statsLine";
    if (state.system === "d20") {
      const ac = document.createElement("span");
      ac.className = "mini";
      ac.textContent = `AC ${c.ac ?? "—"}`;
      stats.appendChild(ac);
    } else {
      const soak = document.createElement("span");
      soak.className = "mini";
      soak.textContent = `Soak ${c?.sr?.soak ?? "—"}`;
      stats.appendChild(soak);
    }

    const hp = hpState(c);
    const hpLine = document.createElement("div");
    hpLine.className = "row";
    hpLine.style.marginTop = "6px";
    hpLine.style.justifyContent = "space-between";

    const hpText = document.createElement("span");
    hpText.className = "mini";
    hpText.textContent = `HP ${c.hp.cur}/${c.hp.max}`;

    const hpPill = document.createElement("span");
    hpPill.className = "pill " + hp.cls;
    hpPill.textContent = hp.label;

    hpLine.appendChild(hpText);
    hpLine.appendChild(hpPill);

    const bar = document.createElement("div");
    bar.className = "barWrap";
    const fill = document.createElement("div");
    fill.className = "barFill";
    fill.style.width = `${Math.round(hp.pct * 100)}%`;
    fill.style.background = hp.cls === "good" ? "#1f6f3f" : (hp.cls === "warn" ? "#7a5a12" : "#7a1f2a");
    bar.appendChild(fill);

    left.appendChild(nameLine);
    left.appendChild(sub);
    left.appendChild(stats);
    left.appendChild(hpLine);
    left.appendChild(bar);

    const right = document.createElement("div");
    right.className = "row";
    right.style.justifyContent = "flex-end";

    const focus = document.createElement("button");
    focus.className = "secondary";
    focus.textContent = "Focus";
    focus.style.padding = "8px 10px";
    focus.onclick = () => setActiveFromRoster(c.id);

    right.appendChild(focus);

    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  pcs().forEach(c => UI.pcList.appendChild(makeCard(c)));
  npcs().forEach(c => UI.npcList.appendChild(makeCard(c)));
}

function renderCombatHeader() {
  UI.roundLabel.textContent = state.encounter.active ? String(state.encounter.round) : "—";
  UI.turnLabel.textContent = state.encounter.active ? String(state.encounter.turn) : "—";
  UI.activeLabel.textContent = activeChar() ? activeChar().name : "—";
  UI.turnStatus.textContent = state.encounter.active ? "Ready." : "—";
  UI.lastActionText.textContent = state.encounter.lastText || "Last Action: —";
}

function renderInitiative() {
  if (!state.encounter.active || !state.encounter.order.length) {
    UI.initList.textContent = "No initiative yet.";
    return;
  }

  const parts = state.encounter.order.map((id, i) => {
    const c = getChar(id);
    if (!c) return null;
    const tag = (id === state.encounter.activeId) ? "▶" : (i + 1) + ".";
    return `${tag} ${c.name} [${c.hp.cur}/${c.hp.max}]`;
  }).filter(Boolean);

  UI.initList.textContent = parts.join("   ");
}

function renderActivePanel() {
  const c = activeChar();

  if (!c) {
    UI.activeRolePill.textContent = "—";
    UI.activeMeta.textContent = "No active character. Start an encounter to begin turns.";
    UI.actions.innerHTML = "";
    UI.targets.innerHTML = "";
    UI.apPill.textContent = "—";
    setActionButtonsVisible(null);
    return;
  }

  UI.activeRolePill.textContent = c.role.toUpperCase();
  UI.activeRolePill.className = "pill " + (c.role === "pc" ? "good" : "warn");

  UI.activeMeta.textContent = `${c.name} • ${c.class || (c.role === "npc" ? "NPC" : "PC")} • HP ${c.hp.cur}/${c.hp.max}` +
    (state.system === "d20" ? ` • AC ${c.ac ?? "—"}` : "");

  // show/hide action-type buttons based on sheet
  setActionButtonsVisible(c);

  // action points toggles
  const ap = state.encounter.ap;
  setToggle(UI.apMove, ap.move);
  setToggle(UI.apAction, ap.action);
  setToggle(UI.apBonus, ap.bonus);
  setToggle(UI.apReaction, ap.reaction);
  UI.apPill.textContent = `${ap.move ? "Move" : ""}${ap.action ? " • Action" : ""}${ap.bonus ? " • Bonus" : ""}${ap.reaction ? " • Reaction" : ""}`.replace(/^ • /, "") || "—";

  // actions list
  UI.actions.innerHTML = "";
  const acts = (c.sheet?.actions || []).filter(a => a && a.name);
  if (!acts.length) {
    const m = document.createElement("div");
    m.className = "muted";
    m.textContent = "No actions on sheet.";
    UI.actions.appendChild(m);
  } else {
    acts.forEach(a => {
      const btn = document.createElement("button");
      btn.className = "secondary actionBtn";
      btn.textContent = `${(a.type || "action").toUpperCase()}: ${a.name}`;
      btn.onclick = () => doAction(c.id, a);
      UI.actions.appendChild(btn);
    });
  }

  renderTargets();
  renderConds();
}

function setToggle(btn, on) {
  btn.classList.toggle("on", !!on);
  btn.classList.toggle("secondary", !on);
}

function setActionButtonsVisible(c) {
  // If no active character, show all but disabled appearance
  const types = c ? new Set((c.sheet?.actions || []).map(a => (a.type || "action"))) : new Set(["move","action","bonus","reaction"]);

  // Always allow move as a category if sheet has move speed
  if (c?.sheet?.move) types.add("move");

  UI.apMove.style.display = types.has("move") ? "" : "none";
  UI.apAction.style.display = types.has("action") ? "" : "none";
  UI.apBonus.style.display = types.has("bonus") ? "" : "none";
  UI.apReaction.style.display = types.has("reaction") ? "" : "none";
}

function renderTargets() {
  UI.targets.innerHTML = "";
  const c = activeChar();
  if (!c) return;

  // Targets include ALL characters plus SELF option (always)
  const all = state.characters.slice();

  // SELF row (for buffs, heals, etc.)
  UI.targets.appendChild(makeTargetRow({ id: c.id, name: c.name }, true));

  // Everyone else
  all.filter(x => x.id !== c.id).forEach(t => {
    UI.targets.appendChild(makeTargetRow(t, false));
  });
}

function makeTargetRow(t, isSelf) {
  const row = document.createElement("div");
  row.className = "targetRow";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.tid = t.id;

  const nm = document.createElement("div");
  nm.className = "targetName";
  nm.textContent = isSelf ? `${t.name} (SELF)` : t.name;

  const chip = document.createElement("span");
  chip.className = "hpChip";
  const full = getChar(t.id);
  chip.textContent = `HP ${full?.hp?.cur ?? "—"}/${full?.hp?.max ?? "—"}`;

  row.appendChild(cb);
  row.appendChild(nm);
  row.appendChild(chip);
  return row;
}

function getSelectedTargetIds() {
  const c = activeChar();
  if (!c) return [];
  const boxes = UI.targets.querySelectorAll("input[type=checkbox]");
  const out = [];
  boxes.forEach(b => { if (b.checked) out.push(b.dataset.tid); });
  // allow 0 targets (some actions are self/scene)
  return out;
}

function renderConds() {
  const c = activeChar();
  if (!c) { UI.condList.textContent = "—"; return; }
  const list = c.conds || [];
  if (!list.length) { UI.condList.textContent = "—"; return; }
  UI.condList.textContent = list.map(x => `• ${x}`).join("  ");
}

/* -----------------------------
   Log / Timeline
-------------------------------- */
function addLog(text) {
  const entry = {
    id: uid(),
    at: nowTs(),
    text: String(text || "").trim(),
    snapshot: snapshotState(),
  };
  state.encounter.log.unshift(entry);
  state.encounter.lastText = "Last Action: " + entry.text.replace(/\s+/g, " ");
  saveState();
  renderCombatHeader();
}

function snapshotState() {
  // Deep copy minimal
  return JSON.parse(JSON.stringify({
    system: state.system,
    characters: state.characters,
    encounter: {
      active: state.encounter.active,
      round: state.encounter.round,
      turn: state.encounter.turn,
      order: state.encounter.order,
      activeId: state.encounter.activeId,
      ap: state.encounter.ap,
    }
  }));
}

function rewindToEntry(entryId) {
  const e = state.encounter.log.find(x => x.id === entryId);
  if (!e || !e.snapshot) return;
  const snap = e.snapshot;

  state.system = snap.system;
  state.characters = snap.characters;
  state.encounter.active = snap.encounter.active;
  state.encounter.round = snap.encounter.round;
  state.encounter.turn = snap.encounter.turn;
  state.encounter.order = snap.encounter.order;
  state.encounter.activeId = snap.encounter.activeId;
  state.encounter.ap = snap.encounter.ap;

  // wipe future log entries AFTER this one (keep older history)
  const idx = state.encounter.log.findIndex(x => x.id === entryId);
  if (idx >= 0) state.encounter.log = state.encounter.log.slice(idx);

  addLog(`Rewound to: ${new Date(e.at).toLocaleString()}`);
  saveState();
  renderAll();
}

function renderLogModal() {
  UI.logList.innerHTML = "";
  const items = state.encounter.log.slice(0, 200);

  if (!items.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No log entries yet.";
    UI.logList.appendChild(d);
    return;
  }

  items.forEach(e => {
    const wrap = document.createElement("div");
    wrap.className = "logEntry";

    const top = document.createElement("div");
    top.className = "logEntryTop";

    const when = document.createElement("div");
    when.className = "muted small";
    when.textContent = new Date(e.at).toLocaleString();

    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Rewind";
    btn.onclick = () => { rewindToEntry(e.id); setModal(false); };

    top.appendChild(when);
    top.appendChild(btn);

    const txt = document.createElement("div");
    txt.className = "logEntryText";
    txt.textContent = e.text;

    wrap.appendChild(top);
    wrap.appendChild(txt);
    UI.logList.appendChild(wrap);
  });
}

/* -----------------------------
   Encounter / Turn flow
-------------------------------- */
function setActiveFromRoster(id) {
  if (!state.encounter.active) {
    // allow focusing outside encounter (for browsing)
    state.encounter.activeId = id;
    saveState();
    renderAll();
    return;
  }
  // during encounter, focusing changes active selection but doesn't advance turns
  state.encounter.activeId = id;
  // reset action points for that focused char? NO — keep encounter AP as-is for current turn
  saveState();
  renderAll();
}

function startEncounter() {
  if (!state.characters.length) return alert("Load or import some characters first.");
  state.encounter.active = true;
  state.encounter.round = 1;
  state.encounter.turn = 0;
  state.encounter.order = [];
  state.encounter.activeId = null;
  state.encounter.ap = { move:true, action:true, bonus:true, reaction:true };
  addLog(`Started encounter (${state.system}).`);
  renderAll();
}

function rollInitiative() {
  if (!state.encounter.active) return alert("Start an encounter first.");
  if (!state.characters.length) return;

  // assign init
  state.characters.forEach(c => {
    if (state.system === "d20") {
      c.init = rollD20() + (c.sheet?.initMod ?? 0);
    } else {
      // d6 pool: init could be reaction+intuition as a number; for now use sheet.initBase + 1d6
      const base = Number(c.sheet?.initBase ?? 7);
      c.init = base + rollD6();
    }
  });

  // sort order descending
  state.encounter.order = state.characters
    .slice()
    .sort((a,b) => (b.init ?? 0) - (a.init ?? 0))
    .map(c => c.id);

  // set first
  state.encounter.turn = 1;
  state.encounter.activeId = state.encounter.order[0] || null;
  state.encounter.ap = { move:true, action:true, bonus:true, reaction:true };

  addLog(`Initiative: ${state.characters.map(c => `${c.name} (${c.init})`).join(", ")}`);
  saveState();
  renderAll();
}

function endTurn() {
  if (!state.encounter.active) return;
  // mark all spent (simple indicator)
  state.encounter.ap = { move:false, action:false, bonus:false, reaction:false };
  addLog(`Ended turn for: ${activeChar()?.name || "—"}`);
  saveState();
  renderAll();
}

function nextTurn() {
  if (!state.encounter.active) return;

  if (!state.encounter.order.length) {
    addLog("Next Turn: no initiative order. (Roll Initiative)");
    saveState();
    renderAll();
    return;
  }

  const curId = state.encounter.activeId;
  const idx = state.encounter.order.findIndex(id => id === curId);
  const nextIdx = (idx < 0) ? 0 : (idx + 1) % state.encounter.order.length;

  // new round if wrapped
  if (idx >= 0 && nextIdx === 0) state.encounter.round += 1;

  state.encounter.turn += 1;
  state.encounter.activeId = state.encounter.order[nextIdx] || null;
  state.encounter.ap = { move:true, action:true, bonus:true, reaction:true };

  addLog(`Next Turn: ${activeChar()?.name || "—"} (Round ${state.encounter.round})`);
  saveState();
  renderAll();
}

/* -----------------------------
   Action resolution (applies damage!)
-------------------------------- */
function doAction(attackerId, action) {
  const a = getChar(attackerId);
  if (!a) return;

  const mode = UI.rollMode.value || "auto";
  const targets = getSelectedTargetIds();

  // spend action points by type (if it exists)
  const type = (action.type || "action").toLowerCase();
  if (type === "move" && !state.encounter.ap.move) return alert("Move already spent this turn.");
  if (type === "action" && !state.encounter.ap.action) return alert("Action already spent this turn.");
  if (type === "bonus" && !state.encounter.ap.bonus) return alert("Bonus already spent this turn.");
  if (type === "reaction" && !state.encounter.ap.reaction) return alert("Reaction already spent this turn.");

  // spend
  if (type === "move") state.encounter.ap.move = false;
  if (type === "action") state.encounter.ap.action = false;
  if (type === "bonus") state.encounter.ap.bonus = false;
  if (type === "reaction") state.encounter.ap.reaction = false;

  const advMode = UI.advMode.value || "none";
  const rollMod = parseMod(UI.rollMod.value);

  let summary = `Action: ${a.name} uses ${action.name}`;

  if (targets.length) {
    const tnames = targets.map(id => getChar(id)?.name || "???").join(", ");
    summary += ` → Targets: ${tnames}`;
  }

  // Resolve based on system
  if (state.system === "d20") {
    const toHit = Number(action.toHit ?? 0);
    const dmgExpr = action.damage || action.dmg || "0";

    // single roll used for all targets (simple + faster)
    let base = mode === "manual"
      ? Number(UI.manualPrimary.value || 0)
      : rollD20();

    base = applyAdvantage(base, advMode);
    const total = base + toHit + rollMod;

    // per-target hit check and damage
    const hits = [];
    targets.forEach(tid => {
      const t = getChar(tid);
      if (!t) return;
      const ac = Number(t.ac ?? 10);
      const hit = total >= ac;

      if (!hit) {
        hits.push(`${t.name}: miss (roll ${total} vs AC ${ac})`);
        return;
      }

      const dmg = mode === "manual"
        ? Number(UI.manualDefense.value || 0) || rollDiceExpr(dmgExpr).total
        : rollDiceExpr(dmgExpr).total;

      applyHpDamage(t, dmg);
      hits.push(`${t.name}: HIT for ${dmg} (HP ${t.hp.cur}/${t.hp.max})`);
    });

    const rollTxt = mode === "manual"
      ? `Roll: ${total} (manual)`
      : `Roll: ${total} (d20=${base} + toHit=${toHit}${rollMod ? ` + mod=${rollMod}` : ""})`;

    addLog(`${summary}\n${rollTxt}\n${hits.join("\n")}`);
  }

  if (state.system === "d6pool") {
    const pool = Number(action.pool ?? action.attackPool ?? 0);
    const baseDamage = Number(action.baseDamage ?? action.damage ?? 0);
    const track = (action.track || "physical").toLowerCase(); // "physical" or "stun"
    const defensePool = Number(action.defensePool ?? 0);

    const primaryHits = (mode === "manual")
      ? Number(UI.manualPrimary.value || 0)
      : rollD6PoolHits(pool + rollMod);

    const defenseHits = (mode === "manual")
      ? Number(UI.manualDefense.value || 0)
      : (targets.length ? rollD6PoolHits(defensePool) : 0);

    const net = Math.max(0, primaryHits - defenseHits);

    const lines = [];
    targets.forEach(tid => {
      const t = getChar(tid);
      if (!t) return;

      const soak = Number(t?.sr?.soak ?? 0);
      const dmg = Math.max(0, baseDamage + net - soak);

      applySrDamage(t, dmg, track);
      lines.push(`${t.name}: netHits=${net}, soak=${soak}, dmg=${dmg} → ${track.toUpperCase()} ${srTrackText(t)}`);
    });

    addLog(`${summary}\nRoll: hits=${primaryHits} vs defense=${defenseHits} (net ${net})\n${lines.join("\n")}`);
  }

  // clear one-time roll modifier/note if you want (leave as-is for now)
  saveState();
  renderAll();
}

function applyHpDamage(target, dmg) {
  const d = Math.max(0, Number(dmg || 0));
  target.hp.cur = clamp(target.hp.cur - d, 0, target.hp.max);
}

function rollD6PoolHits(pool) {
  const n = Math.max(0, Number(pool || 0));
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const r = rollD6();
    if (r >= 5) hits += 1;
  }
  return hits;
}

function applySrDamage(target, dmg, track) {
  if (!target.sr) target.sr = { stun:{cur:0,max:10}, physical:{cur:0,max:10}, soak:0 };
  const tr = track === "stun" ? target.sr.stun : target.sr.physical;
  tr.cur = clamp(tr.cur + Math.max(0, dmg), 0, tr.max);
  // also reflect in HP bar for roster simplicity (HP decreases as damage increases)
  const totalMax = tr.max;
  const remaining = Math.max(0, totalMax - tr.cur);
  target.hp.cur = remaining;
  target.hp.max = totalMax;
}

function srTrackText(t) {
  if (!t.sr) return "";
  return `stun ${t.sr.stun.cur}/${t.sr.stun.max}, phys ${t.sr.physical.cur}/${t.sr.physical.max}`;
}

/* -----------------------------
   Conditions
-------------------------------- */
function addCondition() {
  const c = activeChar();
  if (!c) return;
  const note = String(UI.condNote.value || "").trim();
  if (!note) return;
  c.conds = c.conds || [];
  c.conds.push(note);
  UI.condNote.value = "";
  addLog(`Condition: ${c.name} gains "${note}"`);
  saveState();
  renderAll();
}

function clearConditions() {
  const c = activeChar();
  if (!c) return;
  c.conds = [];
  addLog(`Condition: cleared for ${c.name}`);
  saveState();
  renderAll();
}

/* -----------------------------
   Import / Export / Wipe
-------------------------------- */
function exportJson() {
  UI.jsonBox.value = JSON.stringify(state.characters, null, 2);
}

function importJson() {
  const txt = UI.jsonBox.value || "";
  const arr = safeJsonParse(txt, null);
  if (!Array.isArray(arr)) return alert("Import expects a JSON array of characters.");
  state.characters = arr.map(normalizeChar);
  addLog(`Imported ${state.characters.length} characters.`);
  saveState();
  renderAll();
}

function wipeSession() {
  if (!confirm("Wipe the entire DM session on this device?")) return;
  localStorage.removeItem(LS_DM_STATE);
  state = {
    system: "d20",
    characters: [],
    encounter: {
      active: false, round: 0, turn: 0, order: [], activeId: null,
      ap: { move:true, action:true, bonus:true, reaction:true },
      log: [],
      lastText: "Last Action: —",
    },
  };
  saveState();
  renderAll();
}

/* -----------------------------
   Samples (4 per system)
-------------------------------- */
function loadSamples() {
  const sys = state.system;

  if (sys === "d20") {
    state.characters = [
      normalizeChar({
        id: uid(), role:"pc", name:"Thorin Ironhand", class:"Fighter",
        hp:{cur:28,max:28}, ac:17,
        sheet:{ initMod:2, move:30, actions:[
          { type:"action", name:"Longsword", toHit:5, damage:"1d8+3" },
          { type:"action", name:"Heavy Crossbow", toHit:3, damage:"1d10+1" },
          { type:"bonus", name:"Second Wind", toHit:0, damage:"0" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"pc", name:"Elowen Vale", class:"Wizard",
        hp:{cur:18,max:18}, ac:13,
        sheet:{ initMod:3, move:30, actions:[
          { type:"action", name:"Fire Bolt", toHit:5, damage:"1d10" },
          { type:"action", name:"Magic Missile", toHit:999, damage:"1d4+1" }, // treat as auto-hit by AC check if you want later
          { type:"reaction", name:"Shield", toHit:0, damage:"0" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"npc", name:"Goblin Skirmisher", class:"Skirmisher",
        hp:{cur:12,max:12}, ac:13,
        sheet:{ initMod:2, move:30, actions:[
          { type:"action", name:"Scimitar", toHit:4, damage:"1d6+2" },
          { type:"action", name:"Shortbow", toHit:4, damage:"1d6+2" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"npc", name:"Orc Brute", class:"Brute",
        hp:{cur:30,max:30}, ac:13,
        sheet:{ initMod:1, move:30, actions:[
          { type:"action", name:"Greataxe", toHit:5, damage:"1d12+3" },
          { type:"bonus", name:"Battle Roar", toHit:0, damage:"0" }
        ] }
      }),
    ];
    addLog("Loaded d20 sample pack (4 characters).");
  } else {
    // Shadowrun-like (d6 pool)
    // Use hp bar as track (10 boxes) for simplicity in UI
    state.characters = [
      normalizeChar({
        id: uid(), role:"pc", name:"Kara Ironoak", class:"Street Samurai",
        hp:{cur:10,max:10},
        sr:{ soak:3, stun:{cur:0,max:10}, physical:{cur:0,max:10} },
        sheet:{ initBase:9, actions:[
          { type:"action", name:"Ares Predator (P)", pool:12, defensePool:9, baseDamage:3, track:"physical" },
          { type:"reaction", name:"Full Defense", pool:0, defensePool:12, baseDamage:0, track:"physical" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"pc", name:"Milo Sparks", class:"Decker",
        hp:{cur:10,max:10},
        sr:{ soak:2, stun:{cur:0,max:10}, physical:{cur:0,max:10} },
        sheet:{ initBase:8, actions:[
          { type:"action", name:"Shock Glove (S)", pool:10, defensePool:8, baseDamage:2, track:"stun" },
          { type:"bonus", name:"Take Cover", pool:0, defensePool:0, baseDamage:0, track:"stun" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"npc", name:"Ganger (Pistol)", class:"Ganger",
        hp:{cur:10,max:10},
        sr:{ soak:1, stun:{cur:0,max:10}, physical:{cur:0,max:10} },
        sheet:{ initBase:7, actions:[
          { type:"action", name:"Light Pistol (P)", pool:9, defensePool:8, baseDamage:2, track:"physical" }
        ] }
      }),
      normalizeChar({
        id: uid(), role:"npc", name:"Security Guard", class:"Guard",
        hp:{cur:10,max:10},
        sr:{ soak:2, stun:{cur:0,max:10}, physical:{cur:0,max:10} },
        sheet:{ initBase:7, actions:[
          { type:"action", name:"SMG Burst (P)", pool:10, defensePool:8, baseDamage:3, track:"physical" }
        ] }
      }),
    ];
    addLog("Loaded d6 pool sample pack (4 characters).");
  }

  // reset encounter
  state.encounter.active = false;
  state.encounter.round = 0;
  state.encounter.turn = 0;
  state.encounter.order = [];
  state.encounter.activeId = null;
  state.encounter.ap = { move:true, action:true, bonus:true, reaction:true };

  saveState();
  renderAll();
}

function normalizeChar(c) {
  const out = { ...c };
  out.id = out.id || uid();
  out.role = out.role === "npc" ? "npc" : "pc";
  out.name = String(out.name || "Unnamed");
  out.class = out.class || "";
  out.hp = out.hp || { cur: 10, max: 10 };
  out.hp.cur = Number(out.hp.cur ?? out.hp.max ?? 10);
  out.hp.max = Number(out.hp.max ?? 10);
  out.ac = (out.ac == null) ? 10 : Number(out.ac);

  out.sheet = out.sheet || {};
  out.sheet.actions = Array.isArray(out.sheet.actions) ? out.sheet.actions : [];
  out.sheet.move = (out.sheet.move == null) ? 30 : Number(out.sheet.move);

  out.conds = Array.isArray(out.conds) ? out.conds : [];

  if (!out.sr && state.system === "d6pool") {
    out.sr = { soak:0, stun:{cur:0,max:10}, physical:{cur:0,max:10} };
  }
  return out;
}

/* -----------------------------
   Render all
-------------------------------- */
function renderAll() {
  renderSystem();
  renderRoster();
  renderCombatHeader();
  renderInitiative();
  renderActivePanel();
}

function boot() {
  renderSystem();
  renderAll();

  UI.systemSelect.onchange = () => {
    state.system = UI.systemSelect.value;
    saveState();
    renderAll();
  };

  UI.loadSamplesBtn.onclick = loadSamples;

  UI.startEncounterBtn.onclick = startEncounter;
  UI.rollInitBtn.onclick = rollInitiative;
  UI.endTurnBtn.onclick = endTurn;
  UI.nextTurnBtn.onclick = nextTurn;

  UI.importBtn.onclick = importJson;
  UI.exportBtn.onclick = exportJson;
  UI.wipeBtn.onclick = wipeSession;

  UI.addCondBtn.onclick = addCondition;
  UI.clearCondsBtn.onclick = clearConditions;

  UI.openLogBtn.onclick = () => { renderLogModal(); setModal(true); };
  UI.closeLogBtn.onclick = () => setModal(false);
  UI.logBack.addEventListener("click", (e) => {
    if (e.target === UI.logBack) setModal(false);
  });

  UI.libraryBtn.onclick = () => { /* placeholder */ };

  // default focus: if no encounter active, focus first char
  if (!state.encounter.activeId && state.characters.length) {
    state.encounter.activeId = state.characters[0].id;
    saveState();
    renderAll();
  }

  // log hint
  UI.initHint.textContent = UI.rollMode.value || "auto";
  UI.rollMode.onchange = () => { UI.initHint.textContent = UI.rollMode.value; };
}

boot();
