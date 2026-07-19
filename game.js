// game.js — adds game over conditions + objective scoring + exposes gameOver in client state
import { MAP } from "./data.map.js";

export const BUILD_ID = "adv-legal-hardfix-2026-03-01c+endgame-2026-03-01a";

const RED_FULL_HAND = true; // keep as you have it; set false later if you want symmetric random hands

// Game end tuning knobs
const WIN_POINTS = 12;   // reach this many points to win (public+secret points)
const MAX_TURNS = 16;    // hard stop (tie-break by points)

const CARDS = [
  { id: "DELIBERATE_ADVANCE", name: "Deliberate Advance", cp: 3, target: "REGION", domain: "SURFACE",
    why: "Take/contest adjacent regions (tempo).",
    effect: "Adds friendly presence in target; reduces enemy. Requires adjacency to a controlled region." },
  { id: "RAPID_REDEPLOY", name: "Rapid Redeploy", cp: 3, target: "LINK", domain: "SURFACE",
    why: "Shift force mass quickly.",
    effect: "Moves 25% (min 5, max 20) friendly presence across the link (stronger endpoint → weaker). Requires reach." },
  { id: "FORTIFY_REGION", name: "Fortify Region", cp: 2, target: "REGION", domain: "SURFACE",
    why: "Harden key nodes.",
    effect: "Fort +1 (max 3). Fort reduces enemy advance effectiveness. Requires control." },
  { id: "INTERDICT_LINK", name: "Interdict Link", cp: 3, target: "LINK", domain: "SURFACE",
    why: "Choke supply / isolate fronts.",
    effect: "Link capacity -1 (min 0) + interdicted 2 turns. Requires reach." },
  { id: "SECURE_CORRIDOR", name: "Secure Corridor", cp: 3, target: "LINK", domain: "SURFACE",
    why: "Restore throughput on a route.",
    effect: "Link capacity +1 (max 9). Requires reach." },

  { id: "FOCUSED_ISR_SWEEP", name: "Focused ISR Sweep", cp: 2, target: "REGION", domain: "INFO",
    why: "Improve contacts in a region.",
    effect: "Updates last-seen for target region this turn. Can target any region." },
  { id: "JAMMING_CORRIDOR", name: "Jamming Corridor", cp: 3, target: "LINK", domain: "INFO",
    why: "Degrade enemy visibility on a link.",
    effect: "Jams link (2 turns). Requires reach." },
  { id: "SPOOF_CONTACTS", name: "Spoof Contacts", cp: 3, target: "REGION", domain: "INFO",
    why: "Create deception / feints.",
    effect: "Creates a rumor the ENEMY sees in target region (2 turns). Can target any region." },
  { id: "COUNTERINTEL_SWEEP", name: "Counterintel Sweep", cp: 2, target: "REGION", domain: "INFO",
    why: "Clear enemy deception in your backfield.",
    effect: "Removes ENEMY rumors in target region. Requires control." }
];

function mulberry32(seedInt) {
  return function () {
    seedInt |= 0;
    seedInt = (seedInt + 0x6D2B79F5) | 0;
    let t = Math.imul(seedInt ^ (seedInt >>> 15), 1 | seedInt);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function resolveControl(rt) {
  const bp = rt.bluePresence;
  const rp = rt.redPresence;
  if (bp <= 0 && rp <= 0) return "NEUTRAL";
  if (bp >= rp + 10) return "BLUE";
  if (rp >= bp + 10) return "RED";
  return "CONTESTED";
}
function neighborsFromLinks(links, regionId) {
  const out = [];
  for (const l of links) {
    if (l.a === regionId) out.push({ linkId: l.id, regionId: l.b });
    if (l.b === regionId) out.push({ linkId: l.id, regionId: l.a });
  }
  return out;
}
function linkById(id) {
  return MAP.links.find((l) => l.id === id);
}

function generateObjectives(seed) {
  const rng = mulberry32(hashToInt(seed));
  const comms = MAP.regions.filter((r) => r.type === "COMMS").map((r) => r.id);
  const ports = MAP.regions.filter((r) => r.type === "PORT").map((r) => r.id);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const constraint = [
    "Orbital comm noise: ISR effectiveness reduced by 1 in all COMMS regions for the next 3 turns.",
    "Dust storms: movement ops have +1 detection risk for 2 turns.",
    "Civic sensitivity: losing a HABITAT costs +5 Political Capital immediately."
  ][Math.floor(rng() * 3)];

  return {
    constraint,
    public: {
      blue: [
        { id: "OBJ-B-PUB-1", text: `Control ${pick(comms)} by Turn 6.`, points: 6 },
        { id: "OBJ-B-PUB-2", text: `Keep at least 1 PORT controlled through Turn 8.`, points: 6 }
      ],
      red: [
        { id: "OBJ-R-PUB-1", text: `Cut (capacity 0) any link adjacent to ${pick(ports)} by Turn 6.`, points: 6 },
        { id: "OBJ-R-PUB-2", text: `Contest any HABITAT for 2 consecutive turns by Turn 8.`, points: 6 }
      ]
    },
    secret: {
      blue: [
        { id: "OBJ-B-SEC-1", text: `Fortify a HABITAT to level 2.`, points: 4 },
        { id: "OBJ-B-SEC-2", text: `Reduce Red presence below 30 in any INDUSTRY region.`, points: 4 }
      ],
      red: [
        { id: "OBJ-R-SEC-1", text: `Maintain jammed status on a link for 2 turns.`, points: 4 },
        { id: "OBJ-R-SEC-2", text: `Create 2 active RUMOR contacts inside BLUE-controlled regions.`, points: 4 }
      ]
    }
  };
}

function initialState(seed = "VESPERA", objectivesOverride = null) {
  const s = {
    seed,
    turn: 1,
    cards: CARDS,
    map: deepCopy(MAP),
    truth: { regions: {}, links: {} },
    fog: {
      blueLastSeen: {},
      redLastSeen: {},
      blueRumors: [], // created by BLUE (affect RED)
      redRumors: []   // created by RED  (affect BLUE)
    },
    resources: {
      blue: { cp: 10, isr: 8, political: 100 },
      red: { cp: 10, isr: 8, political: 100 }
    },
    log: [],
    objectives: objectivesOverride || generateObjectives(seed)
  };

  for (const r of s.map.regions) {
    s.truth.regions[r.id] = {
      control: "NEUTRAL",
      bluePresence: 0,
      redPresence: 0,
      fort: 0,
      unrest: 0,
      supplyBlue: "THIN",
      supplyRed: "THIN"
    };
  }
  for (const l of s.map.links) {
    s.truth.links[l.id] = { capacity: l.capacity, interdicted: 0, jammed: 0 };
  }

  // Start positions
  s.truth.regions["R-01"].control = "BLUE";
  s.truth.regions["R-01"].bluePresence = 60;
  s.truth.regions["R-03"].control = "BLUE";
  s.truth.regions["R-03"].bluePresence = 40;

  s.truth.regions["R-12"].control = "RED";
  s.truth.regions["R-12"].redPresence = 60;
  s.truth.regions["R-11"].control = "RED";
  s.truth.regions["R-11"].redPresence = 40;

  for (const r of s.map.regions) {
    s.fog.blueLastSeen[r.id] = 0;
    s.fog.redLastSeen[r.id] = 0;
  }
  s.fog.blueLastSeen["R-01"] = 1;
  s.fog.blueLastSeen["R-03"] = 1;
  s.fog.redLastSeen["R-12"] = 1;
  s.fog.redLastSeen["R-11"] = 1;

  s.log.push(`New game initialized (seed=${seed}). build=${BUILD_ID}`);
  return s;
}

function drawHand(state, sideLower) {
  const ids = state.cards.map((c) => c.id);
  if (RED_FULL_HAND && sideLower === "red") return [...ids];

  const rng = mulberry32(hashToInt(`${state.seed}:${sideLower}:${state.turn}`));
  const hand = [];
  const pool = [...ids];
  while (hand.length < 6 && pool.length > 0) {
    const i = Math.floor(rng() * pool.length);
    hand.push(pool.splice(i, 1)[0]);
  }
  return hand;
}

function recomputeSupply(state) {
  for (const rid of Object.keys(state.truth.regions)) {
    state.truth.regions[rid].supplyBlue = "CUT";
    state.truth.regions[rid].supplyRed = "CUT";
  }

  const bfsSupply = (side) => {
    const seen = new Set();
    const q = [];
    for (const r of state.map.regions) {
      const t = state.truth.regions[r.id];
      if (r.type === "PORT" && t.control === side) {
        q.push(r.id);
        seen.add(r.id);
      }
    }
    while (q.length) {
      const cur = q.shift();
      for (const nb of neighborsFromLinks(state.map.links, cur)) {
        const lt = state.truth.links[nb.linkId];
        if (lt.capacity <= 0) continue;
        const next = nb.regionId;
        if (seen.has(next)) continue;
        const rt = state.truth.regions[next];
        if (rt.control === side || rt.control === "CONTESTED") {
          seen.add(next);
          q.push(next);
        }
      }
    }
    return seen;
  };

  const blueReach = bfsSupply("BLUE");
  const redReach = bfsSupply("RED");

  for (const rid of Object.keys(state.truth.regions)) {
    if (blueReach.has(rid)) state.truth.regions[rid].supplyBlue = "IN_SUPPLY";
    else if (state.truth.regions[rid].control === "BLUE") state.truth.regions[rid].supplyBlue = "THIN";

    if (redReach.has(rid)) state.truth.regions[rid].supplyRed = "IN_SUPPLY";
    else if (state.truth.regions[rid].control === "RED") state.truth.regions[rid].supplyRed = "THIN";
  }
}

function computeAdvanceExpectedFromLinks(state, side) {
  const rt = state.truth.regions;
  const targets = new Set();
  for (const l of state.map.links) {
    const a = rt[l.a];
    const b = rt[l.b];
    if (!a || !b) continue;
    if (a.control === side && b.control !== side) targets.add(l.b);
    if (b.control === side && a.control !== side) targets.add(l.a);
  }
  return [...targets].sort();
}

function computeLegalTargetsByCard(state, side) {
  const rt = state.truth.regions;
  const controlled = new Set(Object.keys(rt).filter((rid) => rt[rid].control === side));
  const friendlyPresenceKey = side === "BLUE" ? "bluePresence" : "redPresence";
  const regionsAll = state.map.regions.map((r) => ({ target_type: "REGION", target_id: r.id }));

  const linkReach = (link) => {
    const a = rt[link.a];
    const b = rt[link.b];
    const presA = a[friendlyPresenceKey] || 0;
    const presB = b[friendlyPresenceKey] || 0;
    return a.control === side || b.control === side || presA >= 10 || presB >= 10;
  };

  const legal = {};

  for (const c of state.cards) {
    if (c.id === "FOCUSED_ISR_SWEEP" || c.id === "SPOOF_CONTACTS") {
      legal[c.id] = regionsAll;
      continue;
    }

    if (c.id === "FORTIFY_REGION" || c.id === "COUNTERINTEL_SWEEP") {
      legal[c.id] = [...controlled].map((rid) => ({ target_type: "REGION", target_id: rid }));
      continue;
    }

    if (c.id === "DELIBERATE_ADVANCE") {
      const expected = computeAdvanceExpectedFromLinks(state, side);
      legal[c.id] = expected.map((rid) => ({ target_type: "REGION", target_id: rid }));
      continue;
    }

    if (c.id === "RAPID_REDEPLOY") {
      const targets = [];
      for (const l of state.map.links) {
        if (!linkReach(l)) continue;
        const a = rt[l.a][friendlyPresenceKey] || 0;
        const b = rt[l.b][friendlyPresenceKey] || 0;
        if (Math.max(a, b) < 10) continue;
        targets.push({ target_type: "LINK", target_id: l.id });
      }
      legal[c.id] = targets;
      continue;
    }

    if (c.id === "INTERDICT_LINK" || c.id === "SECURE_CORRIDOR" || c.id === "JAMMING_CORRIDOR") {
      legal[c.id] = state.map.links.filter(linkReach).map((l) => ({ target_type: "LINK", target_id: l.id }));
      continue;
    }

    legal[c.id] = [];
  }

  return legal;
}

function applyInfoOps(state, side, orders, aar) {
  for (const op of orders.operations) {
    if (op.card_id === "FOCUSED_ISR_SWEEP") {
      const rid = op.targets?.[0]?.target_id;
      if (!rid || !state.truth.regions[rid]) continue;
      state.fog[side === "BLUE" ? "blueLastSeen" : "redLastSeen"][rid] = state.turn;
      aar.push(`${side}: ISR sweep updated picture around ${rid}.`);
    }

    if (op.card_id === "SPOOF_CONTACTS") {
      const rid = op.targets?.[0]?.target_id;
      if (!rid) continue;

      const rumor = {
        id: `${side}-RUMOR-${state.turn}-${Math.floor(Math.random() * 1e6)}`,
        regionId: rid,
        kind: op.parameters?.theme || "unknown",
        expiresTurn: state.turn + 2
      };

      if (side === "BLUE") state.fog.blueRumors.push(rumor);
      else state.fog.redRumors.push(rumor);

      aar.push(`${side}: Deception seeded rumor contact near ${rid}.`);
    }

    if (op.card_id === "COUNTERINTEL_SWEEP") {
      const rid = op.targets?.[0]?.target_id;
      if (!rid) continue;

      const enemyKey = side === "BLUE" ? "redRumors" : "blueRumors";
      const before = state.fog[enemyKey].length;
      state.fog[enemyKey] = state.fog[enemyKey].filter((r) => r.regionId !== rid);
      const removed = before - state.fog[enemyKey].length;

      if (removed > 0) aar.push(`${side}: Counterintel cleared ${removed} enemy rumor(s) at ${rid}.`);
      else aar.push(`${side}: Counterintel found no enemy rumors at ${rid}.`);
    }

    if (op.card_id === "JAMMING_CORRIDOR") {
      const lid = op.targets?.[0]?.target_id;
      if (!lid || !state.truth.links[lid]) continue;
      state.truth.links[lid].jammed = 2;
      aar.push(`${side}: EW jammed link ${lid} (2 turns).`);
    }
  }
}

function applySurfaceOps(state, side, orders, aar) {
  for (const op of orders.operations) {
    if (op.card_id === "INTERDICT_LINK") {
      const lid = op.targets?.[0]?.target_id;
      if (!lid || !state.truth.links[lid]) continue;
      state.truth.links[lid].capacity = clamp(state.truth.links[lid].capacity - 1, 0, 9);
      state.truth.links[lid].interdicted = 2;
      aar.push(`${side}: Interdicted ${lid} (capacity now ${state.truth.links[lid].capacity}).`);
    }

    if (op.card_id === "SECURE_CORRIDOR") {
      const lid = op.targets?.[0]?.target_id;
      if (!lid || !state.truth.links[lid]) continue;
      state.truth.links[lid].capacity = clamp(state.truth.links[lid].capacity + 1, 0, 9);
      aar.push(`${side}: Secured ${lid} (capacity now ${state.truth.links[lid].capacity}).`);
    }

    if (op.card_id === "FORTIFY_REGION") {
      const rid = op.targets?.[0]?.target_id;
      if (!rid || !state.truth.regions[rid]) continue;
      const rt = state.truth.regions[rid];
      if (rt.control !== side) continue;
      rt.fort = clamp(rt.fort + 1, 0, 3);
      aar.push(`${side}: Fortified ${rid} (fort=${rt.fort}).`);
    }

    if (op.card_id === "RAPID_REDEPLOY") {
      const lid = op.targets?.[0]?.target_id;
      const l = linkById(lid);
      if (!l) continue;

      const a = state.truth.regions[l.a];
      const b = state.truth.regions[l.b];
      const key = side === "BLUE" ? "bluePresence" : "redPresence";

      const fromId = a[key] >= b[key] ? l.a : l.b;
      const toId = fromId === l.a ? l.b : l.a;

      const from = state.truth.regions[fromId];
      const to = state.truth.regions[toId];

      const delta = clamp(Math.floor(from[key] * 0.25), 5, 20);
      from[key] = clamp(from[key] - delta, 0, 100);
      to[key] = clamp(to[key] + delta, 0, 100);

      from.control = resolveControl(from);
      to.control = resolveControl(to);
      aar.push(`${side}: Redeployed ${delta} presence from ${fromId} to ${toId}.`);
    }

    if (op.card_id === "DELIBERATE_ADVANCE") {
      const rid = op.targets?.[0]?.target_id;
      if (!rid || !state.truth.regions[rid]) continue;

      const adj = neighborsFromLinks(state.map.links, rid).some((nb) => state.truth.regions[nb.regionId].control === side);
      if (!adj) continue;

      const rt = state.truth.regions[rid];
      const atkKey = side === "BLUE" ? "bluePresence" : "redPresence";
      const defKey = side === "BLUE" ? "redPresence" : "bluePresence";

      const inSupply = side === "BLUE" ? rt.supplyBlue === "IN_SUPPLY" : rt.supplyRed === "IN_SUPPLY";
      const baseAtk = inSupply ? 18 : 10;
      const fortPenalty = rt.fort * 4;

      rt[atkKey] = clamp(rt[atkKey] + baseAtk, 0, 100);
      rt[defKey] = clamp(rt[defKey] - (baseAtk - fortPenalty), 0, 100);

      rt.control = resolveControl(rt);
      aar.push(`${side}: Advanced into ${rid} (fort=${rt.fort}, inSupply=${inSupply}).`);
    }
  }
}

function decayAndTimers(state) {
  state.fog.blueRumors = state.fog.blueRumors.filter((r) => r.expiresTurn >= state.turn);
  state.fog.redRumors = state.fog.redRumors.filter((r) => r.expiresTurn >= state.turn);

  for (const lid of Object.keys(state.truth.links)) {
    const lt = state.truth.links[lid];
    if (lt.interdicted > 0) lt.interdicted -= 1;
    if (lt.jammed > 0) lt.jammed -= 1;
  }

  for (const rid of Object.keys(state.truth.regions)) {
    const rt = state.truth.regions[rid];
    if (rt.control === "BLUE" && rt.supplyBlue === "CUT") rt.bluePresence = clamp(rt.bluePresence - 3, 0, 100);
    if (rt.control === "RED" && rt.supplyRed === "CUT") rt.redPresence = clamp(rt.redPresence - 3, 0, 100);
    rt.control = resolveControl(rt);
  }
}

function scoreObjectives(state) {
  // returns sets of objective IDs completed (no points)
  const completed = { blue: new Set(), red: new Set() };
  const controlOf = (rid) => state.truth.regions[rid]?.control;

  const anyLinkCutAdjacentTo = (regionId) => {
    const adjLinks = state.map.links.filter((l) => l.a === regionId || l.b === regionId).map((l) => l.id);
    return adjLinks.some((lid) => state.truth.links[lid]?.capacity === 0);
  };
  const anyHabitatContested = () => state.map.regions.some((r) => r.type === "HABITAT" && controlOf(r.id) === "CONTESTED");
  const anyJammedLink = () => Object.values(state.truth.links).some((lt) => lt.jammed > 0);

  for (const obj of state.objectives.public.blue) {
    const m = obj.text.match(/Control (R-\d\d)/);
    if (m && state.turn <= 6 && controlOf(m[1]) === "BLUE") completed.blue.add(obj.id);
    if (obj.text.includes("Keep at least 1 PORT") && state.turn <= 8) {
      const anyPort = state.map.regions.some((r) => r.type === "PORT" && controlOf(r.id) === "BLUE");
      if (anyPort) completed.blue.add(obj.id);
    }
  }
  for (const obj of state.objectives.public.red) {
    const m = obj.text.match(/adjacent to (R-\d\d)/);
    if (m && state.turn <= 6 && anyLinkCutAdjacentTo(m[1])) completed.red.add(obj.id);
    if (obj.text.includes("Contest any HABITAT") && anyHabitatContested()) completed.red.add(obj.id);
  }

  // secret examples
  if (state.map.regions.some((r) => r.type === "HABITAT" && state.truth.regions[r.id].fort >= 2 && state.truth.regions[r.id].control === "BLUE")) {
    completed.blue.add("OBJ-B-SEC-1");
  }
  if (state.map.regions.some((r) => r.type === "INDUSTRY" && state.truth.regions[r.id].redPresence < 30)) {
    completed.blue.add("OBJ-B-SEC-2");
  }
  if (anyJammedLink()) completed.red.add("OBJ-R-SEC-1");

  const redRumorsInBlue = state.fog.redRumors.filter((r) => state.truth.regions[r.regionId]?.control === "BLUE").length;
  if (redRumorsInBlue >= 2) completed.red.add("OBJ-R-SEC-2");

  return { blue: [...completed.blue], red: [...completed.red] };
}

function computeObjectivePoints(state) {
  const completed = scoreObjectives(state);

  const idToPoints = new Map();
  for (const o of state.objectives.public.blue) idToPoints.set(o.id, o.points);
  for (const o of state.objectives.public.red) idToPoints.set(o.id, o.points);
  for (const o of state.objectives.secret.blue) idToPoints.set(o.id, o.points);
  for (const o of state.objectives.secret.red) idToPoints.set(o.id, o.points);

  const sum = (ids) => ids.reduce((a, id) => a + (idToPoints.get(id) || 0), 0);

  return {
    completed,
    points: {
      blue: sum(completed.blue),
      red: sum(completed.red)
    },
    // for "public objectives achieved" win condition:
    publicDone: {
      blue: state.objectives.public.blue.every((o) => completed.blue.includes(o.id)),
      red: state.objectives.public.red.every((o) => completed.red.includes(o.id))
    }
  };
}

function computeWipeout(state) {
  let blueTotal = 0;
  let redTotal = 0;
  for (const rid of Object.keys(state.truth.regions)) {
    blueTotal += state.truth.regions[rid].bluePresence || 0;
    redTotal += state.truth.regions[rid].redPresence || 0;
  }
  if (blueTotal <= 0 && redTotal <= 0) return { over: true, winner: "DRAW", reason: "Mutual wipeout", totals: { blueTotal, redTotal } };
  if (blueTotal <= 0) return { over: true, winner: "RED", reason: "Blue wiped out", totals: { blueTotal, redTotal } };
  if (redTotal <= 0) return { over: true, winner: "BLUE", reason: "Red wiped out", totals: { blueTotal, redTotal } };
  return { over: false, totals: { blueTotal, redTotal } };
}

function computeGameOver(state) {
  const wipe = computeWipeout(state);
  const scoring = computeObjectivePoints(state);

  // 1) wipeout always ends it
  if (wipe.over) {
    return {
      over: true,
      winner: wipe.winner,
      reason: wipe.reason,
      endedOnTurn: state.turn,
      points: scoring.points,
      completed: scoring.completed,
      totals: wipe.totals
    };
  }

  // 2) public objective completion ends it
  if (scoring.publicDone.blue && scoring.publicDone.red) {
    const winner = scoring.points.blue === scoring.points.red ? "DRAW" : (scoring.points.blue > scoring.points.red ? "BLUE" : "RED");
    return {
      over: true,
      winner,
      reason: "Both sides completed public objectives",
      endedOnTurn: state.turn,
      points: scoring.points,
      completed: scoring.completed,
      totals: wipe.totals
    };
  }
  if (scoring.publicDone.blue) {
    return { over: true, winner: "BLUE", reason: "Blue completed public objectives", endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
  }
  if (scoring.publicDone.red) {
    return { over: true, winner: "RED", reason: "Red completed public objectives", endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
  }

  // 3) points threshold
  const blueWin = scoring.points.blue >= WIN_POINTS;
  const redWin = scoring.points.red >= WIN_POINTS;
  if (blueWin && redWin) {
    const winner = scoring.points.blue === scoring.points.red ? "DRAW" : (scoring.points.blue > scoring.points.red ? "BLUE" : "RED");
    return { over: true, winner, reason: `Both reached ${WIN_POINTS}+ points`, endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
  }
  if (blueWin) return { over: true, winner: "BLUE", reason: `Blue reached ${WIN_POINTS}+ points`, endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
  if (redWin) return { over: true, winner: "RED", reason: `Red reached ${WIN_POINTS}+ points`, endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };

  // 4) turn limit
  if (state.turn >= MAX_TURNS) {
    const winner = scoring.points.blue === scoring.points.red ? "DRAW" : (scoring.points.blue > scoring.points.red ? "BLUE" : "RED");
    return { over: true, winner, reason: `Turn limit (${MAX_TURNS}) reached`, endedOnTurn: state.turn, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
  }

  return { over: false, winner: null, reason: null, endedOnTurn: null, points: scoring.points, completed: scoring.completed, totals: wipe.totals };
}

function viewForSide(state, side) {
  const lastSeen = side === "BLUE" ? state.fog.blueLastSeen : state.fog.redLastSeen;

  const regions = state.map.regions.map((r) => {
    const t = state.truth.regions[r.id];
    const friendlyPresence = side === "BLUE" ? t.bluePresence : t.redPresence;
    const enemyPresenceTruth = side === "BLUE" ? t.redPresence : t.bluePresence;

    const seenAge = state.turn - (lastSeen[r.id] || 0);
    let enemy = { confidence: "UNKNOWN", estimate: null };
    if (seenAge <= 2) {
      enemy = { confidence: seenAge === 0 ? "CONFIRMED" : "LIKELY", estimate: Math.round(enemyPresenceTruth / 10) * 10 };
    }

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      x: r.x,
      y: r.y,
      control: t.control,
      fort: t.fort,
      unrest: t.unrest,
      supply: side === "BLUE" ? t.supplyBlue : t.supplyRed,
      friendlyPresence,
      enemy
    };
  });

  const links = state.map.links.map((l) => {
    const lt = state.truth.links[l.id];
    const jammed = lt.jammed > 0;
    const capacity = lt.capacity;

    let shownCapacity = capacity;
    if (jammed) {
      const ageA = state.turn - (lastSeen[l.a] || 0);
      const ageB = state.turn - (lastSeen[l.b] || 0);
      if (ageA > 2 && ageB > 2) shownCapacity = null;
    }

    return {
      id: l.id,
      a: l.a,
      b: l.b,
      capacity: shownCapacity,
      jammedTurns: lt.jammed,
      interdictedTurns: lt.interdicted
    };
  });

  const rumorsTruth = side === "BLUE" ? state.fog.redRumors : state.fog.blueRumors;
  const rumors = rumorsTruth.map((r) => ({ id: r.id, regionId: r.regionId, kind: r.kind, expiresTurn: r.expiresTurn }));

  const objectivesForSide = {
    constraint: state.objectives.constraint,
    public: deepCopy(state.objectives.public),
    secret: {
      blue: side === "BLUE" ? deepCopy(state.objectives.secret?.blue || []) : [],
      red: side === "RED" ? deepCopy(state.objectives.secret?.red || []) : []
    }
  };

  const legalTargetsByCard = computeLegalTargetsByCard(state, side);
  const gameOver = computeGameOver(state);

  const expected = computeAdvanceExpectedFromLinks(state, side);
  const legalAdv = (legalTargetsByCard.DELIBERATE_ADVANCE || []).map((t) => t.target_id).sort();
  const mismatch = expected.join(",") !== legalAdv.join(",");

  return {
    seed: state.seed,
    turn: state.turn,
    resources: deepCopy(state.resources[side.toLowerCase()]),
    cards: deepCopy(state.cards),
    hand: drawHand(state, side.toLowerCase()),
    legalTargetsByCard,
    objectives: objectivesForSide,
    constraint: state.objectives.constraint,
    regions,
    links,
    rumors,
    completedObjectives: gameOver.completed,
    gameOver,
    meta: {
      buildId: BUILD_ID,
      advanceExpectedFromLinks: expected,
      advanceLegalTargets: legalAdv,
      advanceMismatch: mismatch
    }
  };
}

function validateAndBudget(state, side, orders) {
  const hand = new Set(drawHand(state, side.toLowerCase()));
  const cpMax = state.resources[side.toLowerCase()].cp;
  const legalTargetsByCard = computeLegalTargetsByCard(state, side);

  let cpSpent = 0;
  const legalOps = [];

  for (const op of orders.operations || []) {
    if (!hand.has(op.card_id)) continue;
    const card = state.cards.find((c) => c.id === op.card_id);
    if (!card) continue;

    const tgt = op.targets?.[0];
    if (!tgt) continue;
    if (card.target !== tgt.target_type) continue;

    const legalTargets = legalTargetsByCard[card.id] || [];
    const isLegal = legalTargets.some((t) => t.target_type === tgt.target_type && t.target_id === tgt.target_id);
    if (!isLegal) continue;

    cpSpent += card.cp;
    if (cpSpent > cpMax) break;

    legalOps.push({ ...op, cp_cost: card.cp });
  }

  return { operations: legalOps };
}

export function newGame(seed, objectivesOverride = null) {
  const s = initialState(seed, objectivesOverride);
  recomputeSupply(s);
  return s;
}

export function getStateForClient(state, side) {
  return viewForSide(state, side);
}

export function commitTurn(state, blueOrders, redOrders) {
  const pre = computeGameOver(state);
  if (pre.over) {
    return { aar: [`Game already over: ${pre.reason}.`], gameOver: pre };
  }

  const aar = [];
  aar.push(`Turn ${state.turn} adjudication:`);

  const blue = validateAndBudget(state, "BLUE", blueOrders);
  const red = validateAndBudget(state, "RED", redOrders);

  applyInfoOps(state, "BLUE", { operations: blue.operations }, aar);
  applyInfoOps(state, "RED", { operations: red.operations }, aar);

  applySurfaceOps(state, "BLUE", { operations: blue.operations }, aar);
  applySurfaceOps(state, "RED", { operations: red.operations }, aar);

  recomputeSupply(state);
  decayAndTimers(state);

  for (const r of state.map.regions) {
    if (r.type === "HABITAT") {
      const t = state.truth.regions[r.id];
      if (t.control === "RED") state.resources.blue.political = clamp(state.resources.blue.political - 1, 0, 999);
      if (t.control === "BLUE") state.resources.red.political = clamp(state.resources.red.political - 1, 0, 999);
    }
  }

  const post = computeGameOver(state);
  if (post.over) {
    aar.push(`GAME OVER: ${post.winner} — ${post.reason}. (Blue ${post.points.blue} vs Red ${post.points.red})`);
  }

  state.turn += 1;

  state.log.push(...aar);
  return { aar, gameOver: post };
}