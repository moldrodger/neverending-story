/* NES DM Console (Phase 1)
   - Character-sheet driven (actions are in the sheet)
   - Supports 2 systems: d20 and d6pool
   - Auto-roll + Manual entry toggle
   - Combat log + rewind (truncate future)
*/

const LS = {
  session: "nes_dm_session_v1"
};

const $ = (id) => document.getElementById(id);

const UI = {
  systemSelect: $("systemSelect"),
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
  nextTurnBtn: $("nextTurnBtn"),
  turnLabel: $("turnLabel"),
  activeLabel: $("activeLabel"),
  log: $("log"),

  activeMeta: $("activeMeta"),
  rollMode: $("rollMode"),
  actions: $("actions"),
  targets: $("targets"),

  manualPrimary: $("manualPrimary"),
  manualDefense: $("manualDefense"),
};

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(LS.session) || "null") || null;
  } catch {
    return null;
  }
}
function saveSession(s) {
  localStorage.setItem(LS.session, JSON.stringify(s));
}

function newSession() {
  return {
    system: "d20",
    roster: [],        // all characters (PC+NPC)
    encounter: {
      started: false,
      order: [],       // array of character ids
      turnIndex: 0
    },
    log: []            // entries: {ts, text, snapshot}
  };
}

let S = loadSession() || newSession();

// ---------------- Utilities ----------------
function now() { return Date.now(); }
function deepCopy(x) { return JSON.parse(JSON.stringify(x)); }

function byId(id) {
  return S.roster.find(c => c.id === id) || null;
}

function pcs() { return S.roster.filter(c => c.role === "PC"); }
function npcs() { return S.roster.filter(c => c.role === "NPC"); }

function activeId() {
  if (!S.encounter.started) return null;
  return S.encounter.order[S.encounter.turnIndex] || null;
}
function activeChar() {
  const id = activeId();
  return id ? byId(id) : null;
}

function setSystem(sys) {
  S.system = sys;
  // Filter roster to system
  S.roster = S.roster.filter(c => c.system === sys);
  // Reset encounter
  S.encounter = { started:false, order:[], turnIndex:0 };
  addLog(`System set to ${sys}. Roster filtered. Encounter reset.`);
  saveSession(S);
  render();
}

function addLog(text) {
  const entry = {
    ts: now(),
    text,
    snapshot: deepCopy(S) // snapshot for rewind
  };
  S.log.push(entry);
  saveSession(S);
  renderLog();
}

function rewindToLogIndex(idx) {
  const entry = S.log[idx];
  if (!entry) return;
  S = deepCopy(entry.snapshot);
  // truncate future
  S.log = S.log.slice(0, idx + 1);
  saveSession(S);
  render();
}

// ---------------- Dice ----------------
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function rollD20() {
  return randInt(1, 20);
}
function rollD6() {
  return randInt(1, 6);
}
function parseDamageFormula(formula) {
  // very small parser: "1d8+3" / "2d6+1" / "1d10"
  const m = String(formula || "").trim().match(/^(\d+)d(\d+)(\s*([+\-])\s*(\d+))?$/i);
  if (!m) return null;
  return {
    n: parseInt(m[1], 10),
    die: parseInt(m[2], 10),
    sign: m[4] || "+",
    mod: m[5] ? parseInt(m[5], 10) : 0
  };
}
function rollDamage(formula) {
  const p = parseDamageFormula(formula);
  if (!p) return { total: 0, detail: `0 (bad formula: ${formula})` };
  let sum = 0;
  const rolls = [];
  for (let i = 0; i < p.n; i++) {
    const r = randInt(1, p.die);
    rolls.push(r);
    sum += r;
  }
  const mod = p.sign === "-" ? -p.mod : p.mod;
  const total = sum + mod;
  return { total, detail: `${rolls.join("+")}${p.mod ? `${p.sign}${p.mod}` : ""} = ${total}` };
}
function d6PoolHits(pool) {
  // hits on 5 or 6
  const rolls = [];
  let hits = 0;
  for (let i = 0; i < pool; i++) {
    const r = rollD6();
    rolls.push(r);
    if (r >= 5) hits++;
  }
  return { hits, rolls };
}

// ---------------- Combat resolution ----------------
function getActionList(c) {
  return Array.isArray(c.actions) ? c.actions : [];
}

function actionPoolFor(c, a) {
  const attr = a?.roll?.attribute ? (c.attributes?.[a.roll.attribute] || 0) : 0;
  const skill = a?.roll?.skill ? (c.skills?.[a.roll.skill] || 0) : 0;
  const mod = a?.roll?.modifier || 0;
  return attr + skill + mod;
}

function getAC(target) {
  // optional derived.ac, else fallback 10
  return target?.derived?.ac ?? 10;
}

function resolveAction(attacker, action, targetIds) {
  const mode = UI.rollMode.value || "auto";
  const targets = targetIds.map(byId).filter(Boolean);
  if (!targets.length) {
    addLog(`No target selected. (${attacker.name}: ${action.label})`);
    return;
  }

  if (attacker.system === "d20") {
    // Minimal: attack vs AC; spells use same attack roll pattern
    const atkMod = action?.roll?.modifier || 0;
    const atkDie = (mode === "manual" && UI.manualPrimary.value.trim())
      ? parseInt(UI.manualPrimary.value.trim(), 10)
      : rollD20();

    const atkTotal = atkDie + atkMod;

    targets.forEach(t => {
      const ac = getAC(t);
      const hit = atkTotal >= ac;

      let dmgText = "";
      if (hit && action.damage?.formula) {
        const dmg = rollDamage(action.damage.formula);
        dmgText = ` Damage: ${dmg.detail} (${action.damage.type || "damage"})`;
        // Apply HP if present
        if (t.tracks?.hp) {
          t.tracks.hp.current = Math.max(0, (t.tracks.hp.current ?? 0) - dmg.total);
        }
      }

      addLog(
        `${attacker.name} uses "${action.label}" on ${t.name}. ` +
        `Roll: ${atkDie} + ${atkMod} = ${atkTotal} vs AC ${ac} => ${hit ? "HIT" : "MISS"}.${dmgText}`
      );
    });

    saveSession(S);
    render();
    return;
  }

  if (attacker.system === "d6pool") {
    // Minimal opposed test: attacker hits vs defender hits (defense pool if available)
    // We’ll use target's reaction + intuition as a default defense pool if present.
    const pool = actionPoolFor(attacker, action);
    const atk =
      (mode === "manual" && UI.manualPrimary.value.trim())
        ? { hits: parseInt(UI.manualPrimary.value.trim(), 10) || 0, rolls: [] }
        : d6PoolHits(Math.max(0, pool));

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
        `Atk pool ${pool} => hits ${atk.hits}. Def pool ${defPool} => hits ${def.hits}. ` +
        `Net hits: ${net}. ${success ? "SUCCESS" : "FAIL"}`
      );
    });

    saveSession(S);
    render();
    return;
  }

  addLog(`Unknown system for action: ${attacker.system}`);
}

// ---------------- Encounter order ----------------
function startEncounter() {
  // Minimal: order = PCs then NPCs (later: initiative)
  const list = [...pcs(), ...npcs()].map(c => c.id);
  if (!list.length) {
    alert("Add at least one character.");
    return;
  }
  S.encounter.started = true;
  S.encounter.order = list;
  S.encounter.turnIndex = 0;
  addLog(`Encounter started. Order: ${list.map(id => byId(id)?.name).join(" → ")}`);
  saveSession(S);
  render();
}

function nextTurn() {
  if (!S.encounter.started || !S.encounter.order.length) return;
  S.encounter.turnIndex = (S.encounter.turnIndex + 1) % S.encounter.order.length;
  const a = activeChar();
  addLog(`Turn advances. Active: ${a ? a.name : "—"}`);
  saveSession(S);
  render();
}

// ---------------- Rendering ----------------
function renderRoster() {
  const sys = S.system;

  const pc = pcs();
  const npc = npcs();

  UI.pcCount.textContent = String(pc.length);
  UI.npcCount.textContent = String(npc.length);

  UI.pcList.innerHTML = "";
  UI.npcList.innerHTML = "";

  const mkItem = (c) => {
    const div = document.createElement("div");
    div.className = "item";
    const left = document.createElement("div");
    left.innerHTML = `<div><b>${c.name}</b></div><div class="muted small">${c.meta?.class || c.meta?.archetype || ""}</div>`;
    const right = document.createElement("button");
    right.className = "secondary";
    right.textContent = "X";
    right.onclick = () => {
      S.roster = S.roster.filter(x => x.id !== c.id);
      // remove from encounter order too
      S.encounter.order = (S.encounter.order || []).filter(id => id !== c.id);
      addLog(`Removed ${c.name} from roster.`);
      saveSession(S);
      render();
    };
    div.appendChild(left);
    div.appendChild(right);
    return div;
  };

  pc.forEach(c => UI.pcList.appendChild(mkItem(c)));
  npc.forEach(c => UI.npcList.appendChild(mkItem(c)));

  // Keep system dropdown in sync
  UI.systemSelect.value = sys;
}

function renderActivePanel() {
  const a = activeChar();
  UI.activeLabel.textContent = a ? a.name : "—";
  UI.turnLabel.textContent = S.encounter.started ? String(S.encounter.turnIndex + 1) : "—";

  if (!a) {
    UI.activeMeta.textContent = "No active character. Start an encounter to begin turns.";
    UI.actions.innerHTML = "";
    UI.targets.innerHTML = "";
    return;
  }

  // meta
  const hp = a.tracks?.hp ? `${a.tracks.hp.current}/${a.tracks.hp.max} HP` : "";
  const phys = a.tracks?.physical ? `Phys ${a.tracks.physical.current}/${a.tracks.physical.max}` : "";
  const stun = a.tracks?.stun ? `Stun ${a.tracks.stun.current}/${a.tracks.stun.max}` : "";
  UI.activeMeta.textContent = `${a.role} • ${a.system} ${hp ? "• " + hp : ""} ${phys ? "• " + phys : ""} ${stun ? "• " + stun : ""}`.trim();

  // actions
  UI.actions.innerHTML = "";
  getActionList(a).forEach(act => {
    const b = document.createElement("button");
    b.className = "actionBtn";
    b.textContent = act.label;
    b.onclick = () => {
      const targetIds = Array.from(UI.targets.querySelectorAll("input[type=checkbox]:checked"))
        .map(x => x.value);
      resolveAction(a, act, targetIds);
    };
    UI.actions.appendChild(b);
  });

  // targets (everyone except attacker)
  UI.targets.innerHTML = "";
  S.roster
    .filter(c => c.system === S.system)
    .filter(c => c.id !== a.id)
    .forEach(c => {
      const row = document.createElement("label");
      row.className = "targetRow";
      row.innerHTML = `<input type="checkbox" value="${c.id}"> <span>${c.name} <span class="pill">${c.role}</span></span>`;
      UI.targets.appendChild(row);
    });
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
      rewindToLogIndex(idx);
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
  renderRoster();
  renderActivePanel();
  renderLog();
}

// ---------------- Import / Export ----------------
function exportRoster() {
  UI.jsonBox.value = JSON.stringify(S.roster, null, 2);
}
function importRoster() {
  let arr;
  try {
    arr = JSON.parse(UI.jsonBox.value.trim());
  } catch {
    alert("Invalid JSON.");
    return;
  }
  if (!Array.isArray(arr)) {
    alert("Expected an array of character objects.");
    return;
  }
  // Force system filter
  const sys = S.system;
  const cleaned = arr
    .filter(x => x && typeof x === "object")
    .filter(x => x.system === sys);

  S.roster = cleaned;
  S.encounter = { started:false, order:[], turnIndex:0 };
  addLog(`Imported ${cleaned.length} ${sys} characters. Encounter reset.`);
  saveSession(S);
  render();
}

function wipeSession() {
  if (!confirm("Wipe DM session? This clears roster, encounter, and log.")) return;
  S = newSession();
  saveSession(S);
  render();
}

// ---------------- Sample packs (4 per system) ----------------
function samplesD20() {
  return [
    {
      id:"d20-pc-1", name:"Thorin Ironhand", role:"PC", system:"d20",
      meta:{ race:"Human", class:"Fighter", level:3 },
      attributes:{ str:16,dex:12,con:14,int:10,wis:11,cha:8 },
      derived:{ ac:16 },
      tracks:{ hp:{ current:28, max:28 } },
      actions:[{ id:"longsword", label:"Longsword Attack", type:"attack", system:"d20",
        roll:{ dice:"1d20", attribute:"str", modifier:5 },
        damage:{ formula:"1d8+3", type:"slashing" },
        targeting:"single"
      }]
    },
    {
      id:"d20-pc-2", name:"Elowen Vale", role:"PC", system:"d20",
      meta:{ race:"Elf", class:"Wizard", level:3 },
      attributes:{ str:8,dex:14,con:12,int:16,wis:13,cha:10 },
      derived:{ ac:13 },
      tracks:{ hp:{ current:18, max:18 } },
      actions:[{ id:"firebolt", label:"Fire Bolt", type:"spell", system:"d20",
        roll:{ dice:"1d20", attribute:"int", modifier:5 },
        damage:{ formula:"1d10", type:"fire" },
        targeting:"single"
      }]
    },
    {
      id:"d20-npc-1", name:"Goblin Skirmisher", role:"NPC", system:"d20",
      meta:{ race:"Goblin", class:"Skirmisher", level:1 },
      attributes:{ str:10,dex:14 }, derived:{ ac:13 },
      tracks:{ hp:{ current:12, max:12 } },
      actions:[{ id:"scimitar", label:"Scimitar Slash", type:"attack", system:"d20",
        roll:{ dice:"1d20", attribute:"dex", modifier:4 },
        damage:{ formula:"1d6+2", type:"slashing" },
        targeting:"single"
      }]
    },
    {
      id:"d20-npc-2", name:"Orc Brute", role:"NPC", system:"d20",
      meta:{ race:"Orc", class:"Brute", level:2 },
      attributes:{ str:18 }, derived:{ ac:13 },
      tracks:{ hp:{ current:30, max:30 } },
      actions:[{ id:"greataxe", label:"Greataxe Swing", type:"attack", system:"d20",
        roll:{ dice:"1d20", attribute:"str", modifier:6 },
        damage:{ formula:"1d12+4", type:"slashing" },
        targeting:"single"
      }]
    }
  ];
}

function samplesD6() {
  return [
    {
      id:"d6-pc-1", name:"Razor", role:"PC", system:"d6pool",
      meta:{ archetype:"Street Samurai", level:1 },
      attributes:{ body:4, agility:5, reaction:4, intuition:4 },
      skills:{ automatics:5, blades:4 },
      tracks:{ physical:{ current:0, max:10 }, stun:{ current:0, max:10 }, edge:{ current:2, max:3 } },
      actions:[{ id:"smg-burst", label:"SMG Burst Fire", type:"attack", system:"d6pool",
        roll:{ dice:"pool", attribute:"agility", skill:"automatics", modifier:0 },
        targeting:"single"
      }]
    },
    {
      id:"d6-pc-2", name:"Hex", role:"PC", system:"d6pool",
      meta:{ archetype:"Mage", level:1 },
      attributes:{ willpower:4, logic:3, reaction:3, intuition:4 },
      skills:{ spellcasting:5, counterspelling:3 },
      tracks:{ physical:{ current:0, max:9 }, stun:{ current:0, max:11 }, edge:{ current:3, max:3 } },
      actions:[{ id:"manabolt", label:"Manabolt (Spellcasting)", type:"spell", system:"d6pool",
        roll:{ dice:"pool", attribute:"willpower", skill:"spellcasting", modifier:0 },
        targeting:"single"
      }]
    },
    {
      id:"d6-npc-1", name:"Corp Security Guard", role:"NPC", system:"d6pool",
      meta:{ archetype:"Guard", level:1 },
      attributes:{ body:3, agility:3, reaction:3, intuition:3 },
      skills:{ pistols:4, clubs:2 },
      tracks:{ physical:{ current:0, max:10 }, stun:{ current:0, max:10 }, edge:{ current:1, max:1 } },
      actions:[{ id:"pistol", label:"Heavy Pistol Shot", type:"attack", system:"d6pool",
        roll:{ dice:"pool", attribute:"agility", skill:"pistols", modifier:0 },
        targeting:"single"
      }]
    },
    {
      id:"d6-npc-2", name:"Steel Lynx Drone", role:"NPC", system:"d6pool",
      meta:{ archetype:"Drone", level:1 },
      attributes:{ body:6, agility:4, reaction:4, intuition:3 },
      skills:{ gunnery:4 },
      tracks:{ physical:{ current:0, max:12 }, stun:{ current:0, max:0 }, edge:{ current:0, max:0 } },
      actions:[{ id:"lmgsuppress", label:"LMG Burst (Gunnery)", type:"attack", system:"d6pool",
        roll:{ dice:"pool", attribute:"agility", skill:"gunnery", modifier:0 },
        targeting:"single"
      }]
    }
  ];
}

function loadSamples() {
  const sys = S.system;
  S.roster = (sys === "d20") ? samplesD20() : samplesD6();
  S.encounter = { started:false, order:[], turnIndex:0 };
  addLog(`Loaded ${sys} sample pack (4 characters).`);
  saveSession(S);
  render();
}

// ---------------- Wire UI ----------------
UI.systemSelect.addEventListener("change", (e) => setSystem(e.target.value));
UI.loadSamplesBtn.addEventListener("click", loadSamples);

UI.exportBtn.addEventListener("click", exportRoster);
UI.importBtn.addEventListener("click", importRoster);
UI.wipeBtn.addEventListener("click", wipeSession);

UI.startEncounterBtn.addEventListener("click", startEncounter);
UI.nextTurnBtn.addEventListener("click", nextTurn);

// Boot
(function boot() {
  // sync dropdown to stored session system
  UI.systemSelect.value = S.system;
  render();
})();
