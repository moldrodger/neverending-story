/* NES DM Console (Phase 1.2) – Initiative + roster overflow fix companion
   Initiative:
   - d20: 1d20 + initMod (derived.initMod OR dexMod fallback)
   - d6pool: Reaction + Intuition + 1d6 (simple Shadowrun-ish)
   - Roll Initiative builds turn order (descending), shows list, persists in session
   - Round counter increments whenever turn wraps
*/

const LS = { session: "nes_dm_session_v3" };
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

  initHint: $("initHint"),
  initList: $("initList"),

  log: $("log"),

  activeMeta: $("activeMeta"),
  activeRolePill: $("activeRolePill"),

  actions: $("actions"),
  targets: $("targets"),

  rollMode: $("rollMode"),
  manualPrimary: $("manualPrimary"),
  manualDefense: $("manualDefense"),

  apPill: $("apPill"),
  apMove: $("apMove"),
  apAction: $("apAction"),
  apBonus: $("apBonus"),
  apReaction: $("apReaction"),

  advMode: $("advMode"),
  rollMod: $("rollMod"),
  condNote: $("condNote"),
  addCondBtn: $("addCondBtn"),
  clearCondsBtn: $("clearCondsBtn"),
  condList: $("condList"),

  libraryBtn: $("libraryBtn"),
};

function safeParseJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function deepCopy(x) { return JSON.parse(JSON.stringify(x)); }
function now() { return Date.now(); }

function loadSession() {
  const raw = localStorage.getItem(LS.session);
  if (!raw) return null;
  return safeParseJSON(raw, null);
}
function saveSession(s) { localStorage.setItem(LS.session, JSON.stringify(s)); }

function newSession() {
  return {
    system: "d20",
    roster: [],
    encounter: { started:false, order:[], turnIndex:0, round:1, initiative:[] }, // initiative: [{id, score, detail}]
    turn: { done:false, ap:{ move:true, action:true, bonus:true, reaction:true } },
    log: []
  };
}

let S = loadSession() || newSession();

// ---------- Roster helpers ----------
function pcs() { return S.roster.filter(c => c.role === "PC"); }
function npcs() { return S.roster.filter(c => c.role === "NPC"); }
function byId(id) { return S.roster.find(c => c.id === id) || null; }

// ---------- Active / Encounter ----------
function activeId() {
  if (!S.encounter.started) return null;
  return S.encounter.order[S.encounter.turnIndex] || null;
}
function activeChar() {
  const id = activeId();
  return id ? byId(id) : null;
}

function resetTurnState() {
  S.turn = { done:false, ap:{ move:true, action:true, bonus:true, reaction:true } };
}

function addLog(text) {
  const snap = deepCopy(S);
  S.log.push({ ts: now(), text, snapshot: snap });
  saveSession(S);
  renderLog();
}

// ---------- HP helpers ----------
function getHP(c) {
  const hp = c?.tracks?.hp;
  if (!hp) return null;
  const cur = Number.isFinite(hp.current) ? hp.current : 0;
  const max = Number.isFinite(hp.max) ? hp.max : 0;
  return { cur, max };
}
function hpPercent(hp) {
  if (!hp || hp.max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((hp.cur / hp.max) * 100)));
}
function hpBand(pct) {
  if (pct <= 0) return "bad";
  if (pct <= 35) return "bad";
  if (pct <= 70) return "warn";
  return "good";
}

// ---------- Mods ----------
function ensureMods(c) {
  if (!c.mods) c.mods = { adv:"none", rollMod:0, notes:[] };
  if (!Array.isArray(c.mods.notes)) c.mods.notes = [];
  if (typeof c.mods.rollMod !== "number") c.mods.rollMod = Number(c.mods.rollMod) || 0;
  if (!["none","adv","dis"].includes(c.mods.adv)) c.mods.adv = "none";
  return c.mods;
}
function parseSignedInt(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------- Dice ----------
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function rollD20() { return randInt(1, 20); }
function rollD6() { return randInt(1, 6); }
function d6PoolHits(pool) {
  const rolls = [];
  let hits = 0;
  for (let i = 0; i < pool; i++) {
    const r = rollD6();
    rolls.push(r);
    if (r >= 5) hits++;
  }
  return { hits, rolls };
}

function parseDamageFormula(formula) {
  const m = String(formula || "").trim().match(/^(\d+)d(\d+)(\s*([+\-])\s*(\d+))?$/i);
  if (!m) return null;
  return { n:+m[1], die:+m[2], sign:(m[4]||"+"), mod:(m[5]?+m[5]:0) };
}
function rollDamage(formula) {
  const p = parseDamageFormula(formula);
  if (!p) return { total: 0, detail: `0 (bad formula: ${formula})` };
  let sum = 0; const rolls = [];
  for (let i = 0; i < p.n; i++) { const r = randInt(1, p.die); rolls.push(r); sum += r; }
  const mod = p.sign === "-" ? -p.mod : p.mod;
  const total = sum + mod;
  return { total, detail: `${rolls.join("+")}${p.mod ? `${p.sign}${p.mod}` : ""} = ${total}` };
}

// ---------- Action economy ----------
function actionCostOf(action) { return action?.cost || "action"; }
function canSpend(cost) {
  if (S.turn.done) return false;
  if (cost === "free") return true;
  return !!S.turn.ap[cost];
}
function spend(cost) { if (cost !== "free") S.turn.ap[cost] = false; }

// ---------- Initiative ----------
function getInitForD20(c) {
  // prefer derived.initMod, else derived.dexMod, else 0
  const initMod =
    (Number.isFinite(c?.derived?.initMod) ? c.derived.initMod :
    (Number.isFinite(c?.derived?.dexMod) ? c.derived.dexMod : 0));
  const die = rollD20();
  return { score: die + initMod, detail: `d20 ${die} + ${initMod}` };
}

function getInitForD6Pool(c) {
  const r = Number(c?.attributes?.reaction || 0);
  const i = Number(c?.attributes?.intuition || 0);
  const die = rollD6();
  const base = r + i;
  return { score: base + die, detail: `(${r}+${i}) + d6 ${die}` };
}

function rollInitiative() {
  const list = [...pcs(), ...npcs()];
  if (!list.length) { alert("Add at least one character."); return; }

  const init = list.map(c => {
    const v = (S.system === "d20") ? getInitForD20(c) : getInitForD6Pool(c);
    return { id: c.id, score: v.score, detail: v.detail };
  });

  init.sort((a,b) => b.score - a.score);

  S.encounter.initiative = init;
  S.encounter.order = init.map(x => x.id);
  S.encounter.turnIndex = 0;
  S.encounter.round = 1;
  S.encounter.started = true;
  resetTurnState();

  addLog("Initiative rolled: " + init.map(x => `${byId(x.id)?.name}(${x.score})`).join(" → "));
  saveSession(S);
  render();
}

function startEncounter() {
  // start encounter without rolling initiative (keeps current roster order)
  const list = [...pcs(), ...npcs()].map(c => c.id);
  if (!list.length) { alert("Add at least one character."); return; }
  S.encounter.started = true;
  S.encounter.order = list;
  S.encounter.turnIndex = 0;
  S.encounter.round = 1;
  S.encounter.initiative = [];
  resetTurnState();
  addLog("Encounter started (no initiative). Order: " + list.map(id => byId(id)?.name).join(" → "));
  saveSession(S);
  render();
}

// ---------- Combat flow ----------
function endTurn() {
  if (!S.encounter.started) return;
  S.turn.done = true;
  addLog(`Turn ended for ${activeChar()?.name || "—"}.`);
  saveSession(S);
  render();
}

function nextTurn() {
  if (!S.encounter.started || !S.encounter.order.length) return;

  const wasLast = (S.encounter.turnIndex === S.encounter.order.length - 1);
  S.encounter.turnIndex = (S.encounter.turnIndex + 1) % S.encounter.order.length;

  if (wasLast) S.encounter.round = (S.encounter.round || 1) + 1;

  resetTurnState();
  addLog(`Turn advances. Active: ${activeChar()?.name || "—"}`);
  saveSession(S);
  render();
}

// ---------- Actions ----------
function getActionList(c) { return Array.isArray(c.actions) ? c.actions : []; }
function getAC(target) { return target?.derived?.ac ?? 10; }
function applyHPDamage(target, dmg) { if (target?.tracks?.hp) target.tracks.hp.current = Math.max(0, (target.tracks.hp.current ?? 0) - dmg); }

function resolveAction(attacker, action, targetIds) {
  const targets = targetIds.map(byId).filter(Boolean);
  if (!targets.length) { addLog(`No target selected. (${attacker.name}: ${action.label})`); return; }

  const cost = actionCostOf(action);
  if (!canSpend(cost)) {
    addLog(`${attacker.name} attempted "${action.label}" but has no ${cost.toUpperCase()} left (or turn is ended).`);
    return;
  }

  const mode = UI.rollMode.value || "auto";
  const mods = ensureMods(attacker);
  const extraMod = mods.rollMod || 0;

  if (attacker.system === "d20") {
    const baseMod = action?.roll?.modifier || 0;
    const totalMod = baseMod + extraMod;

    let dieA = null, dieB = null, chosenDie = null;

    if (mode === "manual" && UI.manualPrimary.value.trim()) {
      chosenDie = parseInt(UI.manualPrimary.value.trim(), 10);
      if (!Number.isFinite(chosenDie)) chosenDie = 0;
    } else {
      dieA = rollD20();
      if (mods.adv === "adv" || mods.adv === "dis") dieB = rollD20();
      if (mods.adv === "adv") chosenDie = Math.max(dieA, dieB ?? dieA);
      else if (mods.adv === "dis") chosenDie = Math.min(dieA, dieB ?? dieA);
      else chosenDie = dieA;
    }

    const atkTotal = (chosenDie || 0) + totalMod;

    targets.forEach(t => {
      const ac = getAC(t);
      const hit = atkTotal >= ac;

      let dmgText = "";
      if (hit && action.damage?.formula) {
        const dmg = rollDamage(action.damage.formula);
        applyHPDamage(t, dmg.total);
        dmgText = ` Damage: ${dmg.detail} (${action.damage.type || "damage"})`;
      }

      const advTxt = (mode === "auto" && (mods.adv === "adv" || mods.adv === "dis") && dieB != null)
        ? ` (${mods.adv === "adv" ? "ADV" : "DIS"}: ${dieA} & ${dieB} => ${chosenDie})`
        : "";

      const modTxt = totalMod !== baseMod ? ` (base ${baseMod}, mods ${extraMod >= 0 ? "+" : ""}${extraMod})` : "";

      addLog(
        `${attacker.name} uses "${action.label}" on ${t.name}. ` +
        `Roll: ${chosenDie}${advTxt} + ${totalMod}${modTxt} = ${atkTotal} vs AC ${ac} => ${hit ? "HIT" : "MISS"}.${dmgText}`
      );
    });

    spend(cost);
    saveSession(S);
    render();
    return;
  }

  if (attacker.system === "d6pool") {
    const attr = action?.roll?.attribute ? (attacker.attributes?.[action.roll.attribute] || 0) : 0;
    const skill = action?.roll?.skill ? (attacker.skills?.[action.roll.skill] || 0) : 0;
    const basePool = (attr + skill + (action?.roll?.modifier || 0));
    const pool = Math.max(0, basePool + extraMod);

    const atk =
      (mode === "manual" && UI.manualPrimary.value.trim())
        ? { hits: parseInt(UI.manualPrimary.value.trim(), 10) || 0, rolls: [] }
        : d6PoolHits(pool);

    targets.forEach(t => {
      const defPool = (t.attributes?.reaction || 0) + (t.attributes?.intuition || 0);
      const def =
        (mode === "manual" && UI.manualDefense.value.trim())
          ? { hits: parseInt(UI.manualDefense.value.trim(), 10) || 0, rolls: [] }
          : d6PoolHits(Math.max(0, defPool));

      const net = atk.hits - def.hits;
      const success = net > 0;

      addLog(
        `${attacker.name} uses "${action.label}" on ${t.name}. ` +
        `Atk pool ${pool} (base ${basePool}, mods ${extraMod >= 0 ? "+" : ""}${extraMod}) => hits ${atk.hits}. ` +
        `Def pool ${defPool} => hits ${def.hits}. Net hits: ${net}. ${success ? "SUCCESS" : "FAIL"}`
      );
    });

    spend(cost);
    saveSession(S);
    render();
    return;
  }

  addLog(`Unknown system for action: ${attacker.system}`);
}

// ---------- Rendering ----------
function renderRoster() {
  UI.systemSelect.value = S.system;
  UI.systemPill.textContent = S.system;

  const pc = pcs();
  const npc = npcs();
  UI.pcCount.textContent = String(pc.length);
  UI.npcCount.textContent = String(npc.length);

  const active = activeId();
  UI.pcList.innerHTML = "";
  UI.npcList.innerHTML = "";

  const mkItem = (c) => {
    ensureMods(c);

    const div = document.createElement("div");
    div.className = "item" + (c.id === active ? " active" : "");

    const left = document.createElement("div");

    const hp = getHP(c);
    const hpPct = hp ? hpPercent(hp) : null;
    const band = hp ? hpBand(hpPct) : null;
    const down = hp ? (hp.cur <= 0) : false;

    const initEntry = (S.encounter.initiative || []).find(x => x.id === c.id);
    const initTxt = initEntry ? `Init ${initEntry.score}` : "";

    const titleRow = document.createElement("div");
    titleRow.className = "row";
    titleRow.style.justifyContent = "space-between";

    const name = document.createElement("div");
    name.innerHTML = `<b>${c.name}</b> ${c.id === active ? `<span class="pill activePill">ACTIVE</span>` : ""}`;

    const role = document.createElement("div");
    role.innerHTML = `<span class="pill">${c.role}</span> ${initTxt ? `<span class="pill" style="margin-left:6px;">${initTxt}</span>` : ""}`;

    titleRow.appendChild(name);
    titleRow.appendChild(role);

    const sub = document.createElement("div");
    sub.className = "muted small";
    sub.textContent = c.meta?.class || c.meta?.archetype || "";

    left.appendChild(titleRow);
    left.appendChild(sub);

    if (hp) {
      const hpLine = document.createElement("div");
      hpLine.className = "row";
      hpLine.style.justifyContent = "space-between";
      hpLine.style.marginTop = "8px";
      hpLine.innerHTML = `
        <span class="pill ${down ? "bad" : band}">${down ? "DOWN" : "HP"}: ${hp.cur}/${hp.max}</span>
        <span class="muted small">${hpPct}%</span>
      `;

      const bar = document.createElement("div");
      bar.className = "barWrap";
      bar.style.marginTop = "6px";

      const fill = document.createElement("div");
      fill.className = "barFill";
      fill.style.width = `${hpPct}%`;
      fill.style.background = down ? "#7a1f2a" : (band === "warn" ? "#7a5a12" : "#1f6f3f");

      bar.appendChild(fill);
      left.appendChild(hpLine);
      left.appendChild(bar);
    }

    const rightCol = document.createElement("div");
    rightCol.className = "row";
    rightCol.style.justifyContent = "flex-end";

    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "X";
    remove.onclick = () => {
      S.roster = S.roster.filter(x => x.id !== c.id);
      S.encounter.order = (S.encounter.order || []).filter(id => id !== c.id);
      S.encounter.initiative = (S.encounter.initiative || []).filter(x => x.id !== c.id);
      addLog(`Removed ${c.name} from roster.`);
      saveSession(S);
      render();
    };

    const focus = document.createElement("button");
    focus.className = "secondary";
    focus.textContent = "Focus";
    focus.onclick = () => {
      if (!S.encounter.started) return;
      const idx = S.encounter.order.indexOf(c.id);
      if (idx >= 0) {
        S.encounter.turnIndex = idx;
        resetTurnState();
        addLog(`Switched active to ${c.name}.`);
        saveSession(S);
        render();
      }
    };

    rightCol.appendChild(focus);
    rightCol.appendChild(remove);

    div.appendChild(left);
    div.appendChild(rightCol);
    return div;
  };

  pc.forEach(c => UI.pcList.appendChild(mkItem(c)));
  npc.forEach(c => UI.npcList.appendChild(mkItem(c)));
}

function renderInitiative() {
  const init = S.encounter.initiative || [];
  if (!init.length) {
    UI.initHint.textContent = "none";
    UI.initList.textContent = "No initiative yet. Click “Roll Initiative”.";
    return;
  }
  UI.initHint.textContent = "sorted";
  UI.initList.textContent = init.map((x, i) => {
    const n = byId(x.id)?.name || x.id;
    return `${i+1}. ${n} — ${x.score} (${x.detail})`;
  }).join("\n");
}

function renderTurnPanel() {
  const a = activeChar();

  UI.activeLabel.textContent = a ? a.name : "—";
  UI.turnLabel.textContent = S.encounter.started ? String(S.encounter.turnIndex + 1) : "—";
  UI.roundLabel.textContent = S.encounter.started ? String(S.encounter.round || 1) : "—";
  UI.turnStatus.textContent = S.encounter.started ? (S.turn.done ? "DONE" : "IN TURN") : "—";
  UI.apPill.textContent = S.turn.done ? "Turn Done" : "Actions Available";

  function setToggle(btn, on) {
    if (!btn) return;
    btn.classList.toggle("on", on);
    btn.classList.toggle("secondary", !on);
  }

  setToggle(UI.apMove, !!S.turn.ap.move);
  setToggle(UI.apAction, !!S.turn.ap.action);
  setToggle(UI.apBonus, !!S.turn.ap.bonus);
  setToggle(UI.apReaction, !!S.turn.ap.reaction);

  const toggle = (k) => {
    if (!S.encounter.started) return;
    S.turn.ap[k] = !S.turn.ap[k];
    saveSession(S);
    renderTurnPanel();
  };
  UI.apMove.onclick = () => toggle("move");
  UI.apAction.onclick = () => toggle("action");
  UI.apBonus.onclick = () => toggle("bonus");
  UI.apReaction.onclick = () => toggle("reaction");

  if (!a) {
    UI.activeMeta.textContent = "No active character. Start an encounter to begin turns.";
    UI.activeRolePill.textContent = "—";
    UI.actions.innerHTML = "";
    UI.targets.innerHTML = "";
    UI.condList.textContent = "";
    return;
  }

  UI.activeRolePill.textContent = a.role;

  const hp = getHP(a);
  const hpTxt = hp ? `${hp.cur}/${hp.max} HP` : "";
  UI.activeMeta.textContent = `${a.role} • ${a.system}${hpTxt ? " • " + hpTxt : ""}`;

  // actions
  UI.actions.innerHTML = "";
  const list = getActionList(a);
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No actions found on this sheet.";
    UI.actions.appendChild(d);
  } else {
    list.forEach(act => {
      const cost = actionCostOf(act);
      const usable = canSpend(cost);
      const b = document.createElement("button");
      b.className = "actionBtn";
      b.disabled = !usable;
      b.textContent = `${act.label}  •  ${cost.toUpperCase()}`;
      b.onclick = () => {
        const targetIds = Array.from(UI.targets.querySelectorAll("input[type=checkbox]:checked"))
          .map(x => x.value);
        resolveAction(a, act, targetIds);
      };
      UI.actions.appendChild(b);
    });
  }

  // targets
  UI.targets.innerHTML = "";
  S.roster
    .filter(c => c.system === S.system)
    .filter(c => c.id !== a.id)
    .forEach(c => {
      const row = document.createElement("label");
      row.className = "targetRow";
      const hp = getHP(c);
      const hpPct = hp ? hpPercent(hp) : null;
      const band = hp ? hpBand(hpPct) : null;
      const down = hp ? (hp.cur <= 0) : false;
      row.innerHTML = `
        <input type="checkbox" value="${c.id}">
        <span style="flex:1;">
          ${c.name} <span class="pill">${c.role}</span>
          ${hp ? `<span class="pill ${down ? "bad" : band}" style="margin-left:6px;">${down ? "DOWN" : "HP"} ${hp.cur}/${hp.max}</span>` : ""}
        </span>
      `;
      UI.targets.appendChild(row);
    });

  const mods = ensureMods(a);
  UI.advMode.value = mods.adv;
  UI.rollMod.value = String(mods.rollMod || 0);
  UI.condList.textContent = mods.notes?.length ? `Notes: ${mods.notes.join(" • ")}` : "No notes.";
}

function renderLog() {
  UI.log.innerHTML = "";
  if (!S.log.length) {
    UI.log.innerHTML = `<div class="muted">No log yet.</div>`;
    return;
  }

  S.log.slice().reverse().forEach((entry, revIdx) => {
    const idx = S.log.length - 1 - revIdx;

    const div = document.createElement("div");
    div.className = "logEntry";

    const top = document.createElement("div");
    top.className = "row";
    top.style.justifyContent = "space-between";

    const left = document.createElement("div");
    left.innerHTML = `<b>#${idx}</b> <span class="muted small">${new Date(entry.ts).toLocaleString()}</span>`;

    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Rewind here";
    btn.onclick = () => {
      if (!confirm("Rewind here? Everything after this point will be removed.")) return;
      const e = S.log[idx];
      S = deepCopy(e.snapshot);
      S.log = S.log.slice(0, idx + 1);
      saveSession(S);
      render();
    };

    top.appendChild(left);
    top.appendChild(btn);

    const txt = document.createElement("div");
    txt.className = "log";
    txt.textContent = entry.text;

    div.appendChild(top);
    div.appendChild(txt);
    UI.log.appendChild(div);
  });
}

function render() {
  if (!S.turn || !S.turn.ap) resetTurnState();

  UI.systemSelect.value = S.system;
  UI.systemPill.textContent = S.system;

  renderRoster();
  renderInitiative();
  renderTurnPanel();
  renderLog();
  saveSession(S);
}

// ---------- Import/Export ----------
function exportRoster() { UI.jsonBox.value = JSON.stringify(S.roster, null, 2); }

function importRoster() {
  const arr = safeParseJSON(UI.jsonBox.value.trim(), null);
  if (!Array.isArray(arr)) { alert("Expected an array of character objects."); return; }

  const sys = S.system;
  const cleaned = arr
    .filter(x => x && typeof x === "object" && x.system === sys)
    .map(x => {
      if (!x.id) x.id = crypto.randomUUID();
      if (!x.role) x.role = "NPC";
      ensureMods(x);
      return x;
    });

  S.roster = cleaned;
  S.encounter = { started:false, order:[], turnIndex:0, round:1, initiative:[] };
  resetTurnState();
  addLog(`Imported ${cleaned.length} ${sys} characters. Encounter reset.`);
  saveSession(S);
  render();
}

function wipeSession() {
  if (!confirm("Wipe DM session? This clears roster, encounter, initiative, and log.")) return;
  S = newSession();
  saveSession(S);
  render();
}

// ---------- Samples ----------
function samplesD20() {
  return [
    {
      id:"d20-pc-1", name:"Thorin Ironhand", role:"PC", system:"d20",
      meta:{ race:"Human", class:"Fighter", level:3 },
      derived:{ ac:16, dexMod:2, initMod:2 },
      tracks:{ hp:{ current:28, max:28 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"longsword", label:"Longsword Attack", cost:"action",
          roll:{ dice:"1d20", modifier:5 },
          damage:{ formula:"1d8+3", type:"slashing" }
        },
        { id:"secondwind", label:"Second Wind (self)", cost:"bonus" }
      ]
    },
    {
      id:"d20-pc-2", name:"Elowen Vale", role:"PC", system:"d20",
      meta:{ race:"Elf", class:"Wizard", level:3 },
      derived:{ ac:13, dexMod:2, initMod:2 },
      tracks:{ hp:{ current:18, max:18 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"firebolt", label:"Fire Bolt", cost:"action",
          roll:{ dice:"1d20", modifier:5 },
          damage:{ formula:"1d10", type:"fire" }
        },
        { id:"mistystep", label:"Misty Step", cost:"bonus" }
      ]
    },
    {
      id:"d20-npc-1", name:"Goblin Skirmisher", role:"NPC", system:"d20",
      meta:{ race:"Goblin", class:"Skirmisher", level:1 },
      derived:{ ac:13, dexMod:2, initMod:2 },
      tracks:{ hp:{ current:12, max:12 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"scimitar", label:"Scimitar Slash", cost:"action",
          roll:{ dice:"1d20", modifier:4 },
          damage:{ formula:"1d6+2", type:"slashing" }
        },
        { id:"disengage", label:"Disengage", cost:"bonus" }
      ]
    },
    {
      id:"d20-npc-2", name:"Orc Brute", role:"NPC", system:"d20",
      meta:{ race:"Orc", class:"Brute", level:2 },
      derived:{ ac:13, dexMod:1, initMod:1 },
      tracks:{ hp:{ current:30, max:30 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"greataxe", label:"Greataxe Swing", cost:"action",
          roll:{ dice:"1d20", modifier:6 },
          damage:{ formula:"1d12+4", type:"slashing" }
        }
      ]
    }
  ];
}

function samplesD6() {
  return [
    {
      id:"d6-pc-1", name:"Razor", role:"PC", system:"d6pool",
      meta:{ archetype:"Street Samurai", level:1 },
      attributes:{ agility:5, reaction:4, intuition:4 },
      skills:{ automatics:5 },
      tracks:{ hp:{ current:10, max:10 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"smg-burst", label:"SMG Burst Fire", cost:"action",
          roll:{ attribute:"agility", skill:"automatics", modifier:0 }
        },
        { id:"dodge", label:"Dodge", cost:"reaction" }
      ]
    },
    {
      id:"d6-pc-2", name:"Hex", role:"PC", system:"d6pool",
      meta:{ archetype:"Mage", level:1 },
      attributes:{ reaction:3, intuition:4, willpower:4 },
      skills:{ spellcasting:5 },
      tracks:{ hp:{ current:9, max:9 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"manabolt", label:"Manabolt", cost:"action",
          roll:{ attribute:"willpower", skill:"spellcasting", modifier:0 }
        },
        { id:"counterspell", label:"Counterspell", cost:"reaction" }
      ]
    },
    {
      id:"d6-npc-1", name:"Corp Security Guard", role:"NPC", system:"d6pool",
      meta:{ archetype:"Guard", level:1 },
      attributes:{ agility:3, reaction:3, intuition:3 },
      skills:{ pistols:4 },
      tracks:{ hp:{ current:10, max:10 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"pistol", label:"Heavy Pistol Shot", cost:"action",
          roll:{ attribute:"agility", skill:"pistols", modifier:0 }
        }
      ]
    },
    {
      id:"d6-npc-2", name:"Steel Lynx Drone", role:"NPC", system:"d6pool",
      meta:{ archetype:"Drone", level:1 },
      attributes:{ agility:4, reaction:4, intuition:3 },
      skills:{ gunnery:4 },
      tracks:{ hp:{ current:12, max:12 } },
      mods:{ adv:"none", rollMod:0, notes:[] },
      actions:[
        { id:"lmg", label:"LMG Burst (Gunnery)", cost:"action",
          roll:{ attribute:"agility", skill:"gunnery", modifier:0 }
        }
      ]
    }
  ];
}

function loadSamples() {
  S.roster = (S.system === "d20") ? samplesD20() : samplesD6();
  S.encounter = { started:false, order:[], turnIndex:0, round:1, initiative:[] };
  resetTurnState();
  addLog(`Loaded ${S.system} sample pack (4 characters).`);
  saveSession(S);
  render();
}

// ---------- Conditions UI ----------
function applyCondChanges() {
  const a = activeChar();
  if (!a) return;
  const mods = ensureMods(a);
  mods.adv = UI.advMode.value || "none";
  mods.rollMod = parseSignedInt(UI.rollMod.value);
  saveSession(S);
  render();
}
function addNote() {
  const a = activeChar();
  if (!a) return;
  const t = String(UI.condNote.value || "").trim();
  if (!t) return;
  const mods = ensureMods(a);
  mods.notes.push(t);
  UI.condNote.value = "";
  saveSession(S);
  render();
}
function clearNotes() {
  const a = activeChar();
  if (!a) return;
  const mods = ensureMods(a);
  mods.notes = [];
  saveSession(S);
  render();
}

// ---------- System switching ----------
function setSystem(sys) {
  S.system = sys;
  S.roster = S.roster.filter(c => c.system === sys);
  S.encounter = { started:false, order:[], turnIndex:0, round:1, initiative:[] };
  resetTurnState();
  addLog(`System set to ${sys}. Roster filtered. Encounter reset.`);
  saveSession(S);
  render();
}

// ---------- Wire UI ----------
UI.systemSelect.addEventListener("change", e => setSystem(e.target.value));
UI.loadSamplesBtn.addEventListener("click", loadSamples);

UI.exportBtn.addEventListener("click", exportRoster);
UI.importBtn.addEventListener("click", importRoster);
UI.wipeBtn.addEventListener("click", wipeSession);

UI.startEncounterBtn.addEventListener("click", startEncounter);
UI.rollInitBtn.addEventListener("click", rollInitiative);

UI.endTurnBtn.addEventListener("click", endTurn);
UI.nextTurnBtn.addEventListener("click", nextTurn);

UI.libraryBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

UI.advMode.addEventListener("change", applyCondChanges);
UI.rollMod.addEventListener("change", applyCondChanges);
UI.addCondBtn.addEventListener("click", addNote);
UI.clearCondsBtn.addEventListener("click", clearNotes);

// Boot
(function boot() {
  S.roster.forEach(ensureMods);
  saveSession(S);
  render();
})();
