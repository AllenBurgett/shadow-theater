# Shadow Theater

Shadow Theater is a local, browser-played operational wargame prototype. You
command BLUE across a node-and-link battlespace while RED is commanded by a
local language model or, when the model is disabled or unavailable, a
deterministic staff planner.

The prototype proves the basic turn loop: inspect a fog-shaped view, spend
command points on operation cards, commit the turn, and review adjudication.
It is reference material for a planned deterministic rules engine, Ollama-backed
RED commander, and war-room-style interface—not a compatibility promise that
every current mechanic or API will survive modernization.

## Current state

- One local, in-memory game exists per server process.
- The server exposes a vanilla HTML/CSS/JavaScript client and JSON API through
  Express.
- The server binds only `127.0.0.1`; it is not intended for LAN or remote play.
- RED can call a local text-generation-webui OpenAI-compatible endpoint or use
  the built-in staff planner when its profile is disabled.
- JSONL logging is available, but the committed prototype defaults can include
  raw model text and RED-only state. The safe quick start below disables it.
- There is no database, account system, multiplayer, cloud service, build step,
  lint configuration, or automated test suite.

The target stack and the retain/replace disposition of Express and Zod will be
decided in [issue #5](https://github.com/AllenBurgett/shadow-theater/issues/5).
The observed prototype inventory is recorded in
[`docs/prototype-baseline.md`](docs/prototype-baseline.md).

## Safe quick start without an LLM

This snapshot was documented with Node `v24.15.0` and npm `10.2.3`. Those are
observed reproduction versions, not the future support policy; issue #5 will
select the supported runtime.

1. Install the locked dependencies:

   ```powershell
   npm ci
   ```

2. Create an ignored `config.local.json` in the repository root:

   ```json
   {
     "server": {
       "port": 3000,
       "seed": "VESPERA-01"
     },
     "logging": {
       "enabled": false
     },
     "llm": {
       "red": {
         "enabled": false
       },
       "gm": {
         "enabled": false
       }
     }
   }
   ```

   `SHADOW_CONFIG` selects this file instead of `config.json`; missing values
   receive the defaults defined by `config.js`. It does not merge the two
   files.

3. Start the server with the local override.

   PowerShell:

   ```powershell
   $env:SHADOW_CONFIG = "config.local.json"
   npm start
   ```

   Bash-compatible shell:

   ```bash
   SHADOW_CONFIG=config.local.json npm start
   ```

4. Open <http://127.0.0.1:3000>. Select a dealt operation card, choose a legal
   map target, and commit the turn. With RED disabled, the staff planner
   supplies RED's legal orders without contacting a model service.

Stop the server with `Ctrl+C`.

## Disabled-LLM API smoke path

With the server running under the override above, a PowerShell smoke sequence
is:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/version

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/new `
  -ContentType "application/json" `
  -Body '{"seed":"VESPERA-01"}'

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/api/commit `
  -ContentType "application/json" `
  -Body '{"blueOrders":{"operations":[]}}'
```

The version and new-game responses should report `ok: true`. The commit should
return `ok: true`, an after-action report, and the next BLUE view. Milestone 0
issue #4 owns the clean-install verification of this documented path.

## Local model configuration

The current adapter in `llm.js` targets text-generation-webui, not Ollama. It
uses `/v1/chat/completions` and optional `/v1/internal/model/*` endpoints at the
configured local `baseUrl`. Ollama is the modernization target, but it is not
wired into this prototype.

If you deliberately enable the current adapter, keep `apiKey` and `adminKey`
only in ignored `config.local.json`, keep `baseUrl` local, and choose the model
and auto-load settings supported by your local server. Never commit credentials
or local model configuration.

## Logging and sensitive data

`logs/` and `config.local.json` are ignored by Git. When logging is enabled,
JSONL files may contain orders, raw model output, and RED fog-of-war state.
Treat them as private diagnostic data: do not commit or share them without
review and sanitization. Prefer `logging.enabled: false` unless you are actively
debugging.

## Known prototype limitations

- The LLM prompt omits important map, supply, objective, rumor, and history
  context, and a spending heuristic can reject otherwise legal model plans.
- Some objective logic is inferred from display text and does not correctly
  preserve completion or consecutive-turn history.
- Some scenario constraints are displayed but not enforced.
- Rumor identifiers use unseeded randomness, preventing exact replay without
  normalization.
- BLUE-facing API behavior can expose RED-only views or secrets if used outside
  the normal browser path.
- Logging defaults disclose more model and hidden-state detail than the target
  product should retain.
- Several diagnostic build IDs and `diag_*` paths are temporary prototype
  scaffolding.

The sanitized reference capture in issue #3 records selected behavior for
comparison without turning these defects into future requirements.

## Prototype layout

| Path | Current responsibility |
|---|---|
| `server.js` | Express static hosting and `/api/*` transport; owns the single in-memory game |
| `game.js` | Rules, state, fog-shaped views, order validation, adjudication, objectives, and victory |
| `llm.js` | RED staff plan, local model call, generated-order parsing, validation, and fallback |
| `config.js` | Zod validation and defaults for the selected JSON configuration file |
| `logger.js` | Optional append-only JSONL game log and in-memory log tail |
| `data.map.js` | Hard-coded prototype map |
| `public/` | Browser UI and API client |
| `config.json` | Committed prototype defaults; not the recommended disabled-LLM quick start |

## Cheap checks

The prototype has no build, lint, typecheck, or automated test command. Its
current syntax gate is:

```powershell
node --check server.js game.js llm.js config.js logger.js data.map.js public/app.js
```

Dependency and runtime decisions belong to issues #5 and #6; do not treat the
versions in this README as ratified target-stack choices.
