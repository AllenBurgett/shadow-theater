#!/usr/bin/env node
// capture-reference.mjs — capture or verify the sanitized deterministic reference
// sequence for Milestone 0 issue #3.
//
//   node tools/capture-reference.mjs --write     Overwrite expected.json from a live run.
//   node tools/capture-reference.mjs --check     Capture again and compare (exit 1 on drift).
//   node tools/capture-reference.mjs --print     Capture and print to stdout, write nothing.
//   node tools/capture-reference.mjs --selftest  Check the rumor-id normalizer without a server.
//
// The script starts its own loopback server with the RED LLM profile and logging
// disabled, drives the documented API sequence, sanitizes and normalizes the
// responses, and then stops the server. It never contacts a model service.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "fixtures", "reference-001");
const SEQUENCE_PATH = path.join(FIXTURE_DIR, "sequence.json");
const EXPECTED_PATH = path.join(FIXTURE_DIR, "expected.json");

const PORT = Number(process.env.REFERENCE_PORT || 3117);
const BASE = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 30000;

/* ---------- sanitization and normalization ---------- */

// RED's rumor identifiers embed Math.random(), so they differ on every capture.
// Replace the random suffix with a stable index assigned in a deterministic
// order. The prototype behavior is left unchanged; only the record is normalized.
function normalizeRumors(rumors) {
  const ordered = [...(rumors || [])].sort((a, b) => {
    const side = String(a.id).split("-")[0].localeCompare(String(b.id).split("-")[0]);
    if (side !== 0) return side;
    if (a.regionId !== b.regionId) return a.regionId < b.regionId ? -1 : 1;
    if (a.expiresTurn !== b.expiresTurn) return a.expiresTurn - b.expiresTurn;
    return String(a.kind).localeCompare(String(b.kind));
  });

  return ordered.map((r, i) => {
    // id shape: <SIDE>-RUMOR-<createdTurn>-<random>
    const parts = String(r.id).split("-");
    const side = parts[0];
    const createdTurn = parts[2];
    return {
      id: `${side}-RUMOR-${createdTurn}-NORM${i}`,
      regionId: r.regionId,
      kind: r.kind,
      expiresTurn: r.expiresTurn
    };
  });
}

// The prototype's BLUE view reports which RED objectives are complete, including
// RED's secret ones. Committing those identifiers would put RED-only information
// into the fixture, so keep RED's public identifiers (already disclosed in
// objectives.public.red) and reduce the secret ones to a count. The count keeps
// the comparison signal; the identifiers stay out of the repository.
function sanitizeCompleted(completed) {
  const red = completed?.red || [];
  return {
    blue: completed?.blue || [],
    redPublic: red.filter((id) => id.startsWith("OBJ-R-PUB")),
    redSecretCompletedCount: red.filter((id) => id.startsWith("OBJ-R-SEC")).length
  };
}

// Keep only fields with a stated comparison purpose. See fixtures/reference-001/README.md.
function sanitizeBlueView(v) {
  return {
    seed: v.seed,
    turn: v.turn,
    resources: v.resources,
    hand: v.hand,
    legalTargetsByCard: v.legalTargetsByCard,
    objectives: {
      constraint: v.objectives?.constraint,
      public: v.objectives?.public,
      // secret.red is already empty in a BLUE view; recording it would invite
      // a future capture to leak RED's secret objectives into the fixture.
      secretBlue: v.objectives?.secret?.blue || []
    },
    regions: (v.regions || []).map((r) => ({
      id: r.id,
      control: r.control,
      fort: r.fort,
      unrest: r.unrest,
      supply: r.supply,
      friendlyPresence: r.friendlyPresence,
      enemy: r.enemy
    })),
    links: (v.links || []).map((l) => ({
      id: l.id,
      capacity: l.capacity,
      jammedTurns: l.jammedTurns,
      interdictedTurns: l.interdictedTurns
    })),
    rumors: normalizeRumors(v.rumors),
    completedObjectives: sanitizeCompleted(v.completedObjectives),
    gameOver: {
      over: v.gameOver?.over,
      winner: v.gameOver?.winner,
      reason: v.gameOver?.reason,
      endedOnTurn: v.gameOver?.endedOnTurn,
      points: v.gameOver?.points,
      totals: v.gameOver?.totals,
      completed: sanitizeCompleted(v.gameOver?.completed)
    },
    meta: {
      buildId: v.meta?.buildId,
      advanceExpectedFromLinks: v.meta?.advanceExpectedFromLinks,
      advanceLegalTargets: v.meta?.advanceLegalTargets,
      advanceMismatch: v.meta?.advanceMismatch
    }
  };
}

/* ---------- server lifecycle ---------- */

function writeTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-reference-"));
  const file = path.join(dir, "config.reference.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        server: { port: PORT, seed: "VESPERA-01" },
        logging: { enabled: false },
        llm: { red: { enabled: false }, gm: { enabled: false } }
      },
      null,
      2
    )
  );
  return { dir, file };
}

async function waitForReady() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/version`);
      if (res.ok) return await res.json();
    } catch {
      // server not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready on ${BASE} within ${STARTUP_TIMEOUT_MS}ms`);
}

function startServer(configFile) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, SHADOW_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`server exited with code ${code}\n${stderr.join("")}`);
    }
  });
  return child;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${url} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/* ---------- capture ---------- */

async function capture() {
  const sequence = JSON.parse(fs.readFileSync(SEQUENCE_PATH, "utf8"));
  const { dir, file } = writeTempConfig();
  const server = startServer(file);

  try {
    const version = await waitForReady();
    const newGame = await postJson(`${BASE}/api/new`, { seed: sequence.seed });

    const steps = [];
    for (const req of sequence.requests) {
      const res = await postJson(`${BASE}/api/commit`, { blueOrders: req.blueOrders });
      steps.push({
        turn: req.turn,
        blueOrders: req.blueOrders,
        aar: res.aar,
        // res.redView is deliberately discarded: it carries RED's fog-of-war
        // state and RED's secret objectives, which must never enter the fixture.
        blueView: sanitizeBlueView(res.blueView)
      });
    }

    return {
      fixtureId: sequence.id,
      seed: sequence.seed,
      // Build identifiers are stable for a given revision. A change here means
      // the fixture describes different code and must be recaptured on purpose.
      gameBuildId: version.gameBuildId,
      llmBuildId: version.llmBuildId,
      newGame: { seed: newGame.seed, gameBuildId: newGame.gameBuildId, llmBuildId: newGame.llmBuildId },
      steps
    };
  } finally {
    server.kill();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/* ---------- self test ---------- */

// The current sequence never surfaces a rumor in the BLUE view: BLUE cannot see
// its own rumors, and the RED staff planner spends its whole budget on advances,
// so it never plays SPOOF_CONTACTS. The normalizer is therefore exercised here
// instead of by the live capture. See fixtures/reference-001/README.md.
function selftest() {
  const sample = (suffixA, suffixB) => [
    { id: `RED-RUMOR-3-${suffixA}`, regionId: "R-03", kind: "supply-buildup", expiresTurn: 5 },
    { id: `RED-RUMOR-2-${suffixB}`, regionId: "R-01", kind: "armour-massing", expiresTurn: 4 }
  ];

  const a = JSON.stringify(normalizeRumors(sample(482913, 77104)));
  const b = JSON.stringify(normalizeRumors(sample(5, 999999)));
  const reordered = JSON.stringify(normalizeRumors(sample(1, 2).reverse()));

  const failures = [];
  if (a !== b) failures.push(`different random suffixes did not normalize equal:\n  ${a}\n  ${b}`);
  if (a !== reordered) failures.push(`input order changed the result:\n  ${a}\n  ${reordered}`);
  if (/RUMOR-\d+-\d{3,}/.test(a)) failures.push(`a random-looking suffix survived normalization: ${a}`);

  if (failures.length) {
    process.stderr.write(`selftest FAILED\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`selftest ok: ${a}\n`);
}

/* ---------- entry point ---------- */

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--print")
    ? "print"
    : "check";

const captured = await capture();
const serialized = `${JSON.stringify(captured, null, 2)}\n`;

if (mode === "print") {
  process.stdout.write(serialized);
} else if (mode === "write") {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(EXPECTED_PATH, serialized);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, EXPECTED_PATH)}\n`);
} else {
  if (!fs.existsSync(EXPECTED_PATH)) {
    process.stderr.write(`missing ${path.relative(REPO_ROOT, EXPECTED_PATH)}; run with --write first\n`);
    process.exit(1);
  }
  const expected = fs.readFileSync(EXPECTED_PATH, "utf8");
  if (expected === serialized) {
    process.stdout.write("reference-001 matches expected.json\n");
  } else {
    process.stderr.write("reference-001 DIFFERS from expected.json\n");
    const a = expected.split("\n");
    const b = serialized.split("\n");
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 20; i++) {
      if (a[i] !== b[i]) {
        process.stderr.write(`  line ${i + 1}:\n    expected: ${a[i] ?? "<eof>"}\n    actual:   ${b[i] ?? "<eof>"}\n`);
        shown++;
      }
    }
    process.exit(1);
  }
}
