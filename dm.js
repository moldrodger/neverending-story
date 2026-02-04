import {
  SYSTEMS,
  createEncounter,
  addCombatant,
  setInitiative,
  sortInitiative,
  nextTurn,
  currentActor,
  resolveD20Attack,
  resolveD20Save,
  resolveOpposedD6Test,
  rewindTo,
} from "./engine.js";

const el = (id) => document.getElementById(id);

const LS_DM_ENCOUNTER = "nes_dm_encounter_min_v1";

const UI = {
  encPill: el("encPill"),
  newEncBtn: el("newEncBtn"),
  saveBtn: el("saveBtn"),
  loadBtn: el("loadBtn"),
  wipeBtn: el("wipeBtn"),

  encTitle: el("encTitle"),
  systemSel: el("systemSel"),
  seed: el("seed"),

  cName: el("cName"),
  cInit: el("cInit"),
  cHP: el("cHP"),
  cAC: el("cAC"),
  cStunMax: el("cStunMax"),
  cPhysMax: el("cPhysMax"),
  cSoak: el("cSoak"),
  addCBtn: el("addCBtn"),

  sortInitBtn: el("sortInitBtn"),
  nextTurnBtn: el("nextTurnBtn"),
  turnInfo: el("turnInfo"),

  actorSel: el("actorSel"),
  targetSel: el("targetSel"),

  rollMode: el("rollMode"),
  manualToHit: el("manualToHit"),
  manualDmg: el("manualDmg"),
  manualHitsA: el("manualHitsA"),
  manualHitsD: el("manualHitsD"),
  manualHitsSoak: el("manualHitsSoak"),

  toHitBonus: el("toHitBonus"),
  dmgExpr: el("dmgExpr"),
  advMode: el("advMode"),
  d20AttackBtn: el("d20AttackBtn"),

  saveStat: el("saveStat"),
  saveDC: el("saveDC"),
  aoeTargets: el("aoeTargets"),
  aoeDmg: el("aoeDmg"),
  saveOnSuccess: el("saveOnSuccess"),
  d20SaveBtn: el("d20SaveBtn"),

  atkDice: el("atkDice"),
  defDice: el("defDice"),
  baseDV: el("baseDV"),
  trackSel: el("trackSel"),
  d6OpposedBtn: el("d6OpposedBtn"),

  resultBox: el("resultBox"),

  cTable: el("cTable"),
  logBox: el("logBox"),
};

let enc = null;

// -----------------------------
// helpers
// -----------------------------
function setPill(text) {
  UI.encPill.textContent = text || "No encounter";
}

function safeNum(v, fallback = 0) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseDiceExpr(expr, fallback = { count: 1, sides: 6, bonus: 0 }) {
  // "1d8+3" or "8d6" or "2d10-1"
  const s = String(expr || "").trim().toLowerCase();
  const m = s.match(/^(\d+)\s*d\s*(\d+)\s*([+\-]\s*\d+)?$/);
  if (!m) return fallback;
  const count = Number(m[1]);
  const sides = Number(m[2]);
  const bonus = m[3] ? Number(m[3].replace(/\s/g, "")) : 0;
  return { count, sides, bonus };
}

function findIdByName(name) {
  const n = String(name || "").trim().toLowerCase();
  const c = enc.combatants.find(x => String(x.name).trim().toLowerCase() === n);
  return c?.id || null;
}

function setResult(obj) {
  UI.resultBox.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function refreshSelectors() {
  const ids = enc?.combatants?.map(c => c.id) || [];
  const opts = ids.map(id => {
    const c = enc.combatants.find(x => x.id === id);
    return { id, label: c ? c.name : id };
  });

  function fill(sel) {
    sel.innerHTML = "";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
  }

  fill(UI.actorSel);
  fill(UI.targetSel);

  // default select first two if possible
  if (opts.length > 0) UI.actorSel.value = opts[0].id;
  if (opts.length > 1) UI.targetSel.value = opts[1].id;
  if (opts.length === 1) UI.targetSel.value = opts[0].id;
}

function refreshTurnInfo() {
  const a = enc ? currentActor(enc) : null;
  if (!a) {
    UI.turnInfo.textContent = "";
    return;
  }
  UI.turnInfo.textContent = `Turn: ${a.name}`;
}

function refreshCombatantsTable() {
  UI.cTable.innerHTML = "";
  for (const c of enc.combatants) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = () => {
      UI.actorSel.value = c.id;
      if (UI.targetSel.value === c.id) return;
      UI.targetSel.value = c.id;
    };

    const tdName = document.createElement("td");
    tdName.textContent = c.name;

    const tdInit = document.createElement("td");
    tdInit.innerHTML = `
      <input data-init="${c.id}" value="${c.init ?? ""}" style="width:90px;">
      <div class="muted">edit + enter</div>
    `;

    const tdD20 = document.createElement("td");
    tdD20.innerHTML = `
      <div>HP: <input data-hp="${c.id}" value="${c.hp ?? ""}" style="width:90px;"></div>
      <div>AC: <input data-ac="${c.id}" value="${c.ac ?? ""}" style="width:90px;"></div>
    `;

    const tdD6 = document.createElement("td");
    const sr = c.sr || { stunDmg:0, stunMax:10, physDmg:0, physMax:10, soakDice:0 };
    tdD6.innerHTML = `
      <div>Stun: <b>${sr.stunDmg}</b> / ${sr.stunMax}</div>
      <div>Phys: <b>${sr.physDmg}</b> / ${sr.physMax}</div>
      <div>SoakDice: <input data-soak="${c.id}" value="${sr.soakDice ?? 0}" style="width:90px;"></div>
    `;

    const tdAct = document.createElement("td");
    tdAct.innerHTML = `
      <button data-del="${c.id}" class="secondary">Remove</button>
    `;

    tr.appendChild(tdName);
    tr.appendChild(tdInit);
    tr.appendChild(tdD20);
    tr.appendChild(tdD6);
    tr.appendChild(tdAct);

    UI.cTable.appendChild(tr);
  }

  // wire inline edits
  UI.cTable.querySelectorAll("input[data-init]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-init");
      setInitiative(enc, id, safeNum(e.target.value, null));
      refreshAll();
    });
  });
  UI.cTable.querySelectorAll("input[data-hp]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-hp");
      const c = enc.combatants.find(x => x.id === id);
      if (!c) return;
      c.hp = e.target.value === "" ? null : safeNum(e.target.value, 0);
      refreshAll();
    });
  });
  UI.cTable.querySelectorAll("input[data-ac]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-ac");
      const c = enc.combatants.find(x => x.id === id);
      if (!c) return;
      c.ac = e.target.value === "" ? null : safeNum(e.target.value, 10);
      refreshAll();
    });
  });
  UI.cTable.querySelectorAll("input[data-soak]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-soak");
      const c = enc.combatants.find(x => x.id === id);
      if (!c) return;
      c.sr = c.sr || {};
      c.sr.soakDice = safeNum(e.target.value, 0);
      refreshAll();
    });
  });

  UI.cTable.querySelectorAll("button[data-del]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-del");
      enc.combatants = enc.combatants.filter(x => x.id !== id);
      refreshAll();
    };
  });
}

function refreshLog() {
  UI.logBox.innerHTML = "";
  const log = enc.log || [];
  if (!log.length) {
    UI.logBox.innerHTML = `<div class="muted">No log entries yet.</div>`;
    return;
  }

  // newest last for timeline feel
  for (const entry of log) {
    const div = document.createElement("div");
    div.className = "logItem";

    const when = new Date(entry.at).toLocaleTimeString();
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <b>${entry.type}</b> <span class="muted">(${when})</span>
        </div>
        <div class="row" style="align-items:center;">
          <button data-rewind="${entry.id}" class="secondary">Rewind here</button>
        </div>
      </div>
      <div class="muted" style="margin-top:6px; white-space:pre-wrap;">${summarize(entry)}</div>
    `;

    div.querySelector("button[data-rewind]").onclick = () => {
      if (!confirm("Rewind to this point? Everything after will be removed.")) return;
      rewindTo(enc, entry.id);
      setResult("Rewound.");
      refreshAll();
    };

    UI.logBox.appendChild(div);
  }
}

function summarize(entry) {
  try {
    const d = entry.detail || {};
    if (entry.type === "d20_attack") {
      return `toHit=${d.toHit?.total} vs AC=${d.ac} hit=${d.hit} dmg=${d.damage?.total ?? 0}`;
    }
    if (entry.type === "d20_save") {
      return `DC=${d.dc} save=${d.saveStat} dmg=${d.damage?.total ?? 0} targets=${(d.results||[]).length}`;
    }
    if (entry.type === "d6pool_opposed") {
      const tr = d.defenderTracks;
      return `atkHits=${d.attack?.hits} defHits=${d.defense?.hits} net=${d.netHits} applied=${d.damageApplied} track=${d.damageTrack}`
        + (tr ? ` | stun ${tr.stun}, phys ${tr.physical}` : "");
    }
    if (entry.type === "initiative_sort") return `order updated`;
    if (entry.type === "turn_next") return `turnIndex=${d.turnIndex}`;
    return JSON.stringify(d);
  } catch {
    return "";
  }
}

function refreshAll() {
  if (!enc) return;
  setPill(`${enc.title} (${enc.system})`);
  refreshSelectors();
  refreshTurnInfo();
  refreshCombatantsTable();
  refreshLog();
}

// -----------------------------
// Actions
// -----------------------------
function newEncounter() {
  const title = (UI.encTitle.value || "Encounter").trim();
  const system = UI.systemSel.value || SYSTEMS.D20;
  const seed = (UI.seed.value || "").trim() || null;

  enc = createEncounter({ system, seed, title });
  setResult("New encounter created.");
  refreshAll();
}

function saveEncounter() {
  if (!enc) return;
  localStorage.setItem(LS_DM_ENCOUNTER, JSON.stringify(enc));
  setResult("Saved to localStorage.");
}

function loadEncounter() {
  const raw = localStorage.getItem(LS_DM_ENCOUNTER);
  if (!raw) {
    alert("No saved encounter found.");
    return;
  }
  enc = JSON.parse(raw);
  setResult("Loaded from localStorage.");
  refreshAll();
}

function wipeEncounter() {
  if (!confirm("Wipe saved encounter and current state?")) return;
  localStorage.removeItem(LS_DM_ENCOUNTER);
  enc = null;
  setPill("No encounter");
  UI.cTable.innerHTML = "";
  UI.logBox.innerHTML = "";
  UI.actorSel.innerHTML = "";
  UI.targetSel.innerHTML = "";
  setResult("Wiped.");
}

function addCombatantFromForm() {
  if (!enc) newEncounter();

  const name = (UI.cName.value || "").trim();
  if (!name) return alert("Name required.");

  const init = UI.cInit.value === "" ? null : safeNum(UI.cInit.value, 0);

  const hp = UI.cHP.value === "" ? null : safeNum(UI.cHP.value, 0);
  const ac = UI.cAC.value === "" ? null : safeNum(UI.cAC.value, 10);

  const stunMax = UI.cStunMax.value === "" ? 10 : safeNum(UI.cStunMax.value, 10);
  const physMax = UI.cPhysMax.value === "" ? 10 : safeNum(UI.cPhysMax.value, 10);
  const soakDice = UI.cSoak.value === "" ? 0 : safeNum(UI.cSoak.value, 0);

  addCombatant(enc, {
    name, init, hp, ac,
    sr: { stunMax, physMax, soakDice },
  });

  UI.cName.value = "";
  UI.cInit.value = "";
  UI.cHP.value = "";
  UI.cAC.value = "";
  UI.cStunMax.value = "";
  UI.cPhysMax.value = "";
  UI.cSoak.value = "";

  refreshAll();
}

function doSortInit() {
  if (!enc) return;
  sortInitiative(enc);
  refreshAll();
  setResult("Initiative sorted.");
}

function doNextTurn() {
  if (!enc) return;
  nextTurn(enc);
  refreshAll();
  setResult(`Next turn: ${currentActor(enc)?.name || "?"}`);
}

function manualOrNull(inputEl) {
  if (UI.rollMode.value !== "manual") return null;
  const v = String(inputEl.value || "").trim();
  if (!v) return null;
  return { total: safeNum(v, 0) };
}

function doD20Attack() {
  if (!enc) return;
  const attackerId = UI.actorSel.value;
  const targetId = UI.targetSel.value;
  if (!attackerId || !targetId) return alert("Pick actor and target.");

  const toHitBonus = safeNum(UI.toHitBonus.value, 0);
  const advMode = UI.advMode.value || "normal";
  const dmg = parseDiceExpr(UI.dmgExpr.value, { count: 1, sides: 8, bonus: 0 });

  const manualToHit = manualOrNull(UI.manualToHit);
  const manualDmg = manualOrNull(UI.manualDmg);

  const out = resolveD20Attack(enc, {
    attackerId,
    targetId,
    toHitBonus,
    advMode,
    damage: dmg,
    manual: { toHit: manualToHit, damage: manualDmg },
  });

  refreshAll();
  setResult(out);
}

function doD20SaveAoE() {
  if (!enc) return;

  const casterId = UI.actorSel.value || null;
  const saveStat = (UI.saveStat.value || "dex").trim().toLowerCase();
  const dc = safeNum(UI.saveDC.value, 13);
  const onSuccess = UI.saveOnSuccess.value || "half";

  // parse targets by names (comma separated)
  const names = String(UI.aoeTargets.value || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!names.length) return alert("Enter AoE targets (comma separated names).");

  const targetIds = names.map(n => findIdByName(n)).filter(Boolean);
  if (!targetIds.length) return alert("No matching target names found.");

  const dmg = parseDiceExpr(UI.aoeDmg.value, { count: 8, sides: 6, bonus: 0 });

  const out = resolveD20Save(enc, {
    casterId,
    targets: targetIds,
    saveStat,
    dc,
    onFail: dmg,
    onSuccess,
    manual: { saves: {}, damage: manualOrNull(UI.manualDmg) },
  });

  refreshAll();
  setResult(out);
}

function doD6Opposed() {
  if (!enc) return;

  const attackerId = UI.actorSel.value;
  const defenderId = UI.targetSel.value;
  if (!attackerId || !defenderId) return alert("Pick actor and target.");

  const attackDice = safeNum(UI.atkDice.value, 0);
  const defenseDice = safeNum(UI.defDice.value, 0);
  const baseDamage = safeNum(UI.baseDV.value, 0);
  const damageTrack = UI.trackSel.value || "physical";

  // Manual mode: allow setting hits directly by converting into “fake rolls”.
  // We use engine’s manual rolls API, so we simulate hits by giving rolls of 6s.
  function manualHitsToManualRoll(hits) {
    if (UI.rollMode.value !== "manual") return null;
    const h = safeNum(hits, 0);
    if (h <= 0) return { rolls: [] };
    return { rolls: Array.from({ length: h }, () => 6) };
  }

  const manualA = manualHitsToManualRoll(UI.manualHitsA.value);
  const manualD = manualHitsToManualRoll(UI.manualHitsD.value);
  const manualSoak = manualHitsToManualRoll(UI.manualHitsSoak.value);

  const out = resolveOpposedD6Test(enc, {
    attackerId,
    defenderId,
    attackDice,
    defenseDice,
    baseDamage,
    damageTrack,
    applySoak: true,
    manual: { attack: manualA, defense: manualD, soak: manualSoak },
  });

  refreshAll();
  setResult(out);
}

// -----------------------------
// Boot
// -----------------------------
function boot() {
  UI.newEncBtn.onclick = newEncounter;
  UI.saveBtn.onclick = saveEncounter;
  UI.loadBtn.onclick = loadEncounter;
  UI.wipeBtn.onclick = wipeEncounter;

  UI.addCBtn.onclick = addCombatantFromForm;
  UI.sortInitBtn.onclick = doSortInit;
  UI.nextTurnBtn.onclick = doNextTurn;

  UI.d20AttackBtn.onclick = doD20Attack;
  UI.d20SaveBtn.onclick = doD20SaveAoE;
  UI.d6OpposedBtn.onclick = doD6Opposed;

  // Create a default encounter on first load (so UI isn't empty)
  enc = createEncounter({ system: UI.systemSel.value || SYSTEMS.D20, seed: null, title: "Encounter" });
  refreshAll();
  setResult("Ready. Create/load an encounter, add combatants, resolve actions.");
}

boot();
