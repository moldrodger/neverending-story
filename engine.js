/* engine.js — Phase 1 DM Engine (d20 + d6pool)
   Updates:
   - Shadowrun-style damage tracks: stun + physical
   - d20 keeps hp/ac
   - event log + snapshots + rewind
*/

export const SYSTEMS = {
  D20: "d20",
  D6POOL: "d6pool",
};

// -----------------------------
// Utilities: RNG + dice
// -----------------------------
export function makeRng(seed = null) {
  if (seed === null || seed === undefined || seed === "") {
    return { random: () => Math.random() };
  }
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i++) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  function mulberry32() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return { random: mulberry32 };
}

export function rollDie(sides, rng) {
  const r = rng?.random ? rng.random() : Math.random();
  return 1 + Math.floor(r * sides);
}

export function rollDice({ count, sides, bonus = 0 }, rng, manual = null) {
  if (manual && typeof manual === "object") {
    if (Array.isArray(manual.rolls)) {
      const sum = manual.rolls.reduce((a, b) => a + (Number(b) || 0), 0);
      return { rolls: manual.rolls.slice(), total: sum + bonus, bonus, manual: true };
    }
    if (typeof manual.total === "number") {
      return { rolls: [], total: manual.total, bonus: 0, manual: true };
    }
  }
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(rollDie(sides, rng));
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { rolls, total: sum + bonus, bonus, manual: false };
}

export function rollD20({ bonus = 0, mode = "normal" }, rng, manual = null) {
  if (manual?.rolls && Array.isArray(manual.rolls)) {
    const r = manual.rolls.map(n => Number(n) || 0);
    const pick = pickAdvDis(r, mode);
    return { rolls: r, picked: pick, total: pick + bonus, bonus, mode, manual: true };
  }

  const a = rollDie(20, rng);
  let b = null;
  let picked = a;

  if (mode === "adv" || mode === "dis") {
    b = rollDie(20, rng);
    picked = pickAdvDis([a, b], mode);
  }

  return { rolls: b === null ? [a] : [a, b], picked, total: picked + bonus, bonus, mode, manual: false };
}

function pickAdvDis(rolls, mode) {
  if (!rolls.length) return 0;
  if (mode === "adv") return Math.max(...rolls);
  if (mode === "dis") return Math.min(...rolls);
  return rolls[0];
}

export function rollD6Pool({ dice, limit = null }, rng, manual = null) {
  if (manual?.rolls && Array.isArray(manual.rolls)) {
    const rolls = manual.rolls.map(n => Number(n) || 0);
    let hits = rolls.filter(x => x >= 5).length;
    if (typeof limit === "number") hits = Math.min(hits, limit);
    return { rolls, hits, limit, manual: true };
  }

  const rolls = [];
  for (let i = 0; i < dice; i++) rolls.push(rollDie(6, rng));
  let hits = rolls.filter(x => x >= 5).length;
  if (typeof limit === "number") hits = Math.min(hits, limit);
  return { rolls, hits, limit, manual: false };
}

// -----------------------------
// Encounter + storage shapes
// -----------------------------
export function createEncounter({ system, seed = null, title = "Encounter" }) {
  return {
    id: crypto.randomUUID(),
    title,
    system,              // "d20" | "d6pool"
    seed: seed ?? null,
    createdAt: Date.now(),
    combatants: [],
    turnIndex: 0,
    log: [],
  };
}

export function addCombatant(enc, c) {
  const combatant = {
    id: c.id || crypto.randomUUID(),
    name: c.name || "Unknown",

    // d20 style
    hp: typeof c.hp === "number" ? c.hp : null,
    ac: typeof c.ac === "number" ? c.ac : null,

    // shared
    init: typeof c.init === "number" ? c.init : null,
    stats: c.stats || {},
    conditions: Array.isArray(c.conditions) ? c.conditions : [],
    actionCards: Array.isArray(c.actionCards) ? c.actionCards : [],

    // d6pool / Shadowrun style (Option B)
    sr: {
      stunMax: Number(c?.sr?.stunMax ?? c?.stunMax ?? 10) || 10,
      physMax: Number(c?.sr?.physMax ?? c?.physMax ?? 10) || 10,
      stunDmg: Number(c?.sr?.stunDmg ?? c?.stunDmg ?? 0) || 0,
      physDmg: Number(c?.sr?.physDmg ?? c?.physDmg ?? 0) || 0,
      soakDice: Number(c?.sr?.soakDice ?? c?.soakDice ?? 0) || 0,
    },
  };
  enc.combatants.push(combatant);
  return combatant;
}

export function snapshot(enc) {
  return JSON.parse(JSON.stringify(enc));
}

export function pushLog(enc, entry) {
  const full = {
    id: crypto.randomUUID(),
    at: Date.now(),
    ...entry,
    snapshot: snapshot(enc),
  };
  enc.log.push(full);
  return full;
}

export function rewindTo(enc, entryId) {
  const idx = enc.log.findIndex(e => e.id === entryId);
  if (idx < 0) throw new Error("rewindTo: entry not found");

  const snap = enc.log[idx].snapshot;
  const keepId = enc.id;
  const keepTitle = enc.title;

  Object.keys(enc).forEach(k => delete enc[k]);
  Object.assign(enc, snapshot(snap));

  enc.id = keepId;
  enc.title = keepTitle;

  enc.log = enc.log.slice(0, idx + 1);
  return enc;
}

// -----------------------------
// Shadowrun damage helpers (Option B)
// -----------------------------
export function applyShadowrunDamage(target, track, amount) {
  if (!target?.sr) return;

  const n = Math.max(0, Number(amount) || 0);
  if (n === 0) return;

  if (track === "stun") {
    target.sr.stunDmg = Math.min(target.sr.stunMax, target.sr.stunDmg + n);
    // Optional rule: overflow converts to physical (simple)
    if (target.sr.stunDmg >= target.sr.stunMax) {
      const overflow = target.sr.stunDmg - target.sr.stunMax;
      if (overflow > 0) {
        target.sr.stunDmg = target.sr.stunMax;
        target.sr.physDmg = Math.min(target.sr.physMax, target.sr.physDmg + overflow);
      }
    }
  } else {
    target.sr.physDmg = Math.min(target.sr.physMax, target.sr.physDmg + n);
  }
}

export function isShadowrunIncapacitated(target) {
  if (!target?.sr) return false;
  return (target.sr.physDmg >= target.sr.physMax) || (target.sr.stunDmg >= target.sr.stunMax);
}

// -----------------------------
// Initiative helpers
// -----------------------------
export function setInitiative(enc, combatantId, value) {
  const c = enc.combatants.find(x => x.id === combatantId);
  if (!c) throw new Error("Combatant not found");
  c.init = Number(value);
  pushLog(enc, { type: "initiative_manual", combatantId, detail: { init: c.init } });
}

export function sortInitiative(enc) {
  enc.combatants.sort((a, b) => {
    const ai = (typeof a.init === "number") ? a.init : -9999;
    const bi = (typeof b.init === "number") ? b.init : -9999;
    if (bi !== ai) return bi - ai;
    return String(a.name).localeCompare(String(b.name));
  });
  enc.turnIndex = 0;
  pushLog(enc, { type: "initiative_sort", detail: { order: enc.combatants.map(c => c.id) } });
}

export function nextTurn(enc) {
  if (!enc.combatants.length) return;
  enc.turnIndex = (enc.turnIndex + 1) % enc.combatants.length;
  pushLog(enc, { type: "turn_next", detail: { turnIndex: enc.turnIndex } });
}

export function currentActor(enc) {
  return enc.combatants[enc.turnIndex] || null;
}

// -----------------------------
// d20 resolution
// -----------------------------
export function resolveD20Attack(enc, {
  attackerId,
  targetId,
  toHitBonus = 0,
  advMode = "normal",
  damage = { count: 1, sides: 8, bonus: 0, type: "slashing" },
  manual = { toHit: null, damage: null },
  allowCrit = true,
} = {}) {
  const rng = makeRng(enc.seed);
  const a = enc.combatants.find(x => x.id === attackerId);
  const t = enc.combatants.find(x => x.id === targetId);
  if (!a || !t) throw new Error("Attacker/target not found");

  const toHit = rollD20({ bonus: toHitBonus, mode: advMode }, rng, manual?.toHit);
  const ac = (typeof t.ac === "number") ? t.ac : 10;
  const nat20 = toHit.rolls.includes(20);
  const nat1 = toHit.rolls.includes(1);
  const hit = nat20 ? true : (nat1 ? false : (toHit.total >= ac));

  let dmg = { rolls: [], total: 0, bonus: 0, manual: false };
  let crit = false;

  if (hit) {
    const dmgDice = { ...damage };
    if (allowCrit && nat20) {
      crit = true;
      dmgDice.count = (damage.count || 0) * 2;
    }
    dmg = rollDice(dmgDice, rng, manual?.damage);

    if (typeof t.hp === "number") t.hp = Math.max(0, t.hp - dmg.total);
  }

  const entry = pushLog(enc, {
    type: "d20_attack",
    system: SYSTEMS.D20,
    attackerId,
    targetId,
    detail: { toHit, ac, hit, crit, damage: dmg, damageType: damage.type || null },
  });

  return { entry, toHit, hit, crit, damage: dmg, targetHp: t.hp };
}

export function resolveD20Save(enc, {
  casterId = null,
  targets = [],
  saveStat = "dex",
  dc = 13,
  onFail = { count: 8, sides: 6, bonus: 0, type: "fire" },
  onSuccess = "half",
  manual = { saves: {}, damage: null }
} = {}) {
  const rng = makeRng(enc.seed);
  const dmg = rollDice(onFail, rng, manual?.damage);

  const results = [];
  for (const tid of targets) {
    const t = enc.combatants.find(x => x.id === tid);
    if (!t) continue;

    const bonus = Number(t.stats?.[`${saveStat}_save`] ?? t.stats?.[saveStat] ?? 0) || 0;
    const saveRoll = rollD20({ bonus, mode: "normal" }, rng, manual?.saves?.[tid] || null);
    const success = saveRoll.total >= dc;

    let applied = 0;
    if (!success) applied = dmg.total;
    else if (onSuccess === "half") applied = Math.floor(dmg.total / 2);
    else if (onSuccess === "none") applied = 0;

    if (typeof t.hp === "number") t.hp = Math.max(0, t.hp - applied);

    results.push({
      targetId: tid,
      save: saveRoll,
      success,
      appliedDamage: applied,
      hpAfter: t.hp,
    });
  }

  const entry = pushLog(enc, {
    type: "d20_save",
    system: SYSTEMS.D20,
    casterId,
    detail: { saveStat, dc, damage: dmg, onSuccess, results },
  });

  return { entry, damage: dmg, results };
}

// -----------------------------
// d6pool / Shadowrun-like resolution (Option B)
/// -----------------------------
export function resolveD6PoolTest(enc, {
  actorId,
  poolDice,
  limit = null,
  threshold = null,
  manual = null,
} = {}) {
  const rng = makeRng(enc.seed);
  const a = enc.combatants.find(x => x.id === actorId);
  if (!a) throw new Error("Actor not found");

  const r = rollD6Pool({ dice: poolDice, limit }, rng, manual);
  const pass = (typeof threshold === "number") ? (r.hits >= threshold) : null;

  const entry = pushLog(enc, {
    type: "d6pool_test",
    system: SYSTEMS.D6POOL,
    actorId,
    detail: { roll: r, threshold, pass },
  });

  return { entry, roll: r, pass };
}

export function resolveOpposedD6Test(enc, {
  attackerId,
  defenderId,
  attackDice,
  defenseDice,
  attackLimit = null,
  defenseLimit = null,
  baseDamage = 0,          // base DV
  damageTrack = "physical",// "physical" | "stun"
  applySoak = true,
  soakDice = null,         // override or use defender.sr.soakDice
  manual = { attack: null, defense: null, soak: null }
} = {}) {
  const rng = makeRng(enc.seed);
  const atk = enc.combatants.find(x => x.id === attackerId);
  const def = enc.combatants.find(x => x.id === defenderId);
  if (!atk || !def) throw new Error("Attacker/defender not found");

  const aRoll = rollD6Pool({ dice: attackDice, limit: attackLimit }, rng, manual?.attack);
  const dRoll = rollD6Pool({ dice: defenseDice, limit: defenseLimit }, rng, manual?.defense);

  const netHits = Math.max(0, aRoll.hits - dRoll.hits);
  const hit = netHits > 0;

  let dv = hit ? (baseDamage + netHits) : 0;

  let soak = null;
  if (hit && applySoak) {
    const soakPool = (typeof soakDice === "number")
      ? soakDice
      : Number(def?.sr?.soakDice ?? 0) || 0;

    soak = rollD6Pool({ dice: soakPool, limit: null }, rng, manual?.soak);
    dv = Math.max(0, dv - soak.hits);
  }

  if (hit && dv > 0) {
    applyShadowrunDamage(def, damageTrack, dv);
  }

  const entry = pushLog(enc, {
    type: "d6pool_opposed",
    system: SYSTEMS.D6POOL,
    attackerId,
    defenderId,
    detail: {
      attack: aRoll,
      defense: dRoll,
      netHits,
      baseDamage,
      damageTrack,
      appliedSoak: applySoak,
      soak,
      damageApplied: dv,
      defenderTracks: def.sr ? {
        stun: `${def.sr.stunDmg}/${def.sr.stunMax}`,
        physical: `${def.sr.physDmg}/${def.sr.physMax}`,
        incapacitated: isShadowrunIncapacitated(def),
      } : null,
    },
  });

  return { entry, hit, netHits, damageApplied: dv, attack: aRoll, defense: dRoll, soak };
}
