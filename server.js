// server.js — add redView mutation diagnostics + version includes LLM build id
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { newGame, getStateForClient, commitTurn, BUILD_ID as GAME_BUILD_ID } from "./game.js";
import { getRedOrders, LLM_BUILD_ID } from "./llm.js";
import { loadConfig } from "./config.js";
import { GameLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = loadConfig();

const app = express();
app.use(express.json({ limit: "2mb" }));

let STATE = null;
let LOGGER = null;

function newGameId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function makeLogger(seed) {
  const gameId = newGameId();
  return new GameLogger({
    enabled: config.logging.enabled,
    dir: config.logging.dir,
    keepInMemory: config.logging.keepInMemory,
    includeRawLlmText: config.logging.includeRawLlmText,
    includeRedView: config.logging.includeRedView,
    gameId,
    seed
  });
}

async function makeState(seed) {
  LOGGER = makeLogger(seed);
  STATE = newGame(seed, null);

  LOGGER.log("server_start", {
    gameBuildId: GAME_BUILD_ID,
    llmBuildId: LLM_BUILD_ID,
    node: process.version
  });

  LOGGER.log("state_initialized", { turn: STATE.turn });
  return STATE;
}

app.use("/", express.static(path.join(__dirname, "public")));

app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    buildId: GAME_BUILD_ID,     // keep backwards compatible name
    gameBuildId: GAME_BUILD_ID,
    llmBuildId: LLM_BUILD_ID,
    node: process.version
  });
});

app.get("/api/state", (req, res) => {
  if (!STATE) return res.status(503).json({ ok: false, error: "Game not initialized yet." });
  const side = (req.query.side || "blue").toString().toLowerCase() === "red" ? "RED" : "BLUE";
  res.json(getStateForClient(STATE, side));
});

app.post("/api/new", async (req, res) => {
  try {
    const seed = (req.body?.seed || config.server.seed || `VESPERA-${Date.now()}`).toString();
    await makeState(seed);
    res.json({ ok: true, seed, gameBuildId: GAME_BUILD_ID, llmBuildId: LLM_BUILD_ID });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

function extractAdvanceIdsFromLegal(redView) {
  const arr = redView?.legalTargetsByCard?.DELIBERATE_ADVANCE || [];
  return arr.map((t) => t.target_id).sort();
}

app.post("/api/commit", async (req, res) => {
  try {
    if (!STATE) return res.status(503).json({ ok: false, error: "Game not initialized yet." });

    const blueOrders = req.body?.blueOrders || { operations: [] };

    const redView = getStateForClient(STATE, "RED");

    // Existing diagnostic from your hardfix build:
    LOGGER?.log("diag_advance_legality", {
      turn: redView.turn,
      buildId: redView.meta?.buildId,
      advanceExpectedFromLinks: redView.meta?.advanceExpectedFromLinks || [],
      advanceLegalTargets: redView.meta?.advanceLegalTargets || [],
      advanceMismatch: !!redView.meta?.advanceMismatch
    });

    // NEW: capture the actual legalTargetsByCard before we call getRedOrders
    const preAdv = extractAdvanceIdsFromLegal(redView);
    LOGGER?.log("diag_redview_pre_llm", {
      turn: redView.turn,
      gameBuildId: GAME_BUILD_ID,
      llmBuildId: LLM_BUILD_ID,
      metaAdvanceLegalTargets: redView.meta?.advanceLegalTargets || [],
      legalTargetsByCardAdvance: preAdv
    });

    const redOrders = await getRedOrders({ redView, config, logger: LOGGER });

    // NEW: check if getRedOrders mutated the redView object
    const postAdv = extractAdvanceIdsFromLegal(redView);
    const mutated = preAdv.join(",") !== postAdv.join(",");
    LOGGER?.log("diag_redview_post_llm", {
      turn: redView.turn,
      mutated,
      legalTargetsByCardAdvance: postAdv
    });

    LOGGER?.log("turn_commit", {
      turn: STATE.turn,
      blueOrders,
      redOrders
    });

    const { aar } = commitTurn(STATE, blueOrders, redOrders);

    LOGGER?.log("turn_result", {
      turn: STATE.turn - 1,
      aar
    });

    res.json({
      ok: true,
      aar,
      blueView: getStateForClient(STATE, "BLUE"),
      redView: getStateForClient(STATE, "RED")
    });
  } catch (e) {
    LOGGER?.log("error", { where: "commit", error: String(e?.message || e) });
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/logs", (req, res) => {
  if (!LOGGER || !LOGGER.enabled) return res.json({ ok: true, enabled: false, entries: [] });
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "200", 10), 2000));
  res.json({
    ok: true,
    enabled: true,
    filePath: LOGGER.filePath,
    entries: LOGGER.tail(limit)
  });
});

app.get("/api/logs/download", (req, res) => {
  if (!LOGGER || !LOGGER.enabled || !LOGGER.filePath) return res.status(404).send("Logging disabled or no log file.");
  res.download(LOGGER.filePath);
});

(async () => {
  await makeState(config.server.seed);

  const port = config.server.port;
  app.listen(port, () => {
    console.log(`Shadow Theater running on http://127.0.0.1:${port}`);
    console.log(`GAME_BUILD_ID=${GAME_BUILD_ID}`);
    console.log(`LLM_BUILD_ID=${LLM_BUILD_ID}`);
    console.log(`Logging enabled=${!!config.logging.enabled} dir=${config.logging.dir}`);
    if (LOGGER?.enabled) console.log(`Log file: ${LOGGER.filePath}`);
  });
})();