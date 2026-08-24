# Prototype runtime and dependency baseline

Snapshot date: 2026-07-19

Issue: [#2](https://github.com/AllenBurgett/shadow-theater/issues/2)

This document records the observed prototype, not the supported target stack.
Issue #5 owns the supported runtime and retain/replace decisions. Issue #6 owns
approved upgrades for dependencies that #5 retains.

## Observed environment

| Evidence | Observed value |
|---|---|
| Node | `v24.15.0` |
| npm | `10.2.3` |
| Package manager | npm with lockfile version 3 |
| Package scripts | `start` only (`node server.js`) |
| Direct production dependencies | 2 |
| Direct development dependencies | 0 |
| Build/transpile step | none |
| Automated tests, lint, and typecheck | none configured |

The application uses built-in `fetch`, `AbortController`, and
`structuredClone`, so its actual runtime floor is newer than the absence of an
`engines` field suggests. This inventory does not infer or declare that floor;
issue #5 must select and document a supported Node line. Resolved: issue #5
selected Node 24 LTS, and issue #6 declared `"engines": { "node": ">=24" }` in
`package.json`.

## Direct dependency ownership

Values below come from `package.json`, `package-lock.json`, and
`npm ls --depth=0` on the snapshot date. The Requested and Resolved columns are
that historical snapshot and predate the issue #6 upgrade; the Decision column
records what was decided and shipped since.

| Dependency | Requested | Resolved | Current responsibility | Decision |
|---|---:|---:|---|---|
| Express | `^4.19.2` | `4.22.1` | JSON parsing, static browser assets, HTTP routes, downloads, and loopback listener in `server.js` | #5: retained — upgraded to `^5.2.1` by #6 |
| Zod | `^3.23.8` | `3.25.76` | JSON configuration validation/defaults in `config.js`; generated RED operation validation in `llm.js` | #5: retained — upgraded to `^4.4.3` by #6 |

No package was declared retained merely because the prototype used it. Per the
approved Milestone 0 policy, #6 upgraded to current stable,
mutually-compatible versions only for the dependencies #5 retained. A
dependency selected for replacement stays pinned unless it blocks an approved
retained dependency from upgrading.

## Read-only security inventory

Command used:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
npm audit --json
```

The system-CA option was needed for the local Windows certificate environment;
it did not change repository configuration. npm returned exit code 1 because
findings exist.

| Severity | Package | Direct? | Recorded advisory/effect | Audit disposition |
|---|---|---:|---|---|
| High | `path-to-regexp@0.1.12` | No, via Express | ReDoS with multiple route parameters ([GHSA-37ch-88jc-xwx2](https://github.com/advisories/GHSA-37ch-88jc-xwx2)) | Fix available; route through #5/#6 |
| Moderate | `qs@6.14.2` | No, via Express/body-parser | Remotely triggerable denial of service ([GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)) | Fix available; route through #5/#6 |
| Moderate | `body-parser@1.20.4` | No, via Express | Affected through `qs` | Fix available; route through #5/#6 |
| Moderate | `express@4.22.1` | Yes | Affected through `qs` | Fix available; retain/replace decision in #5 |

Audit summary: 4 affected packages (1 high, 3 moderate, 0 critical). No
dependency or lockfile was changed by issue #2, and these findings are not yet
accepted risk. Milestone 0 issue #4 cannot close until #6 fixes urgent findings
or Allen explicitly accepts the remaining risk.

Resolved: the issue #6 upgrade to Express `^5.2.1` and Zod `^4.4.3` cleared all
four findings above. `npm audit` on the upgraded lockfile reports
`found 0 vulnerabilities`, so no finding required an accepted-risk decision.
The table remains the snapshot-date record.

## Runtime shape and ownership

| Path | Current responsibility and coupling |
|---|---|
| `server.js` | Loads config, owns the single mutable game, constructs the logger, serves `public/`, exposes the API, obtains RED orders, and binds `127.0.0.1` |
| `game.js` | Contains map-derived rules, seeded hand/objective generation, side views, order validation/budgeting, adjudication, objective scoring, and game-over logic |
| `llm.js` | Builds a heuristic staff plan, optionally calls a local OpenAI-compatible model endpoint, extracts and validates generated JSON, compares it with staff spending, and falls back on failure |
| `config.js` | Selects `config.json` or `SHADOW_CONFIG`, parses JSON, applies Zod defaults, and rejects invalid values |
| `logger.js` | Writes optional per-game JSONL logs synchronously and retains an optional in-memory tail |
| `data.map.js` | Exports the fixed 12-region, 13-link map |
| `public/app.js` | Maintains browser interaction state, renders the SVG map/panels, queues BLUE orders, and calls the API |
| `public/index.html`, `public/style.css` | Static application shell and visual styling |

There is no database or persistence layer. Restarting the server creates a new
game and loses in-memory state. Logs are diagnostics, not replay-capable saves.

## HTTP and process boundary

The Express process serves browser assets and these routes:

| Method and path | Current purpose |
|---|---|
| `GET /api/version` | Build/runtime diagnostics |
| `GET /api/state?side=blue` | Side-shaped current state; the normal browser asks for BLUE |
| `POST /api/new` | Replace the process-global game with a new seed |
| `POST /api/commit` | Obtain RED orders, adjudicate BLUE and RED, return AAR and views |
| `GET /api/logs` | Return the in-memory diagnostic tail when logging is enabled |
| `GET /api/logs/download` | Download the current JSONL log when enabled |

The listener is explicitly loopback-only. The API has no authentication because
the product is a trusted local single-player application. Any future exposure
change requires a separate full-Specify decision.

## Configuration boundary

`SHADOW_CONFIG` selects one JSON file; configuration files are not merged.
Missing keys receive Zod defaults.

| Key group | Current purpose |
|---|---|
| `server.port`, `server.seed` | Loopback port and initial deterministic seed |
| `logging.*` | JSONL enablement/path, in-memory tail, and inclusion of raw LLM or RED-view data |
| `llm.red.*` | RED model enablement, local base URL, credentials, model, auto-load, sampling, and timeout |
| `llm.gm.*` | Parsed second profile; currently not called by the game/server path |

The committed `config.json` enables RED, model auto-load, logging, raw model
text, and RED-view inclusion. The documented friend-safe procedure instead
selects ignored `config.local.json` with RED and logging disabled. `apiKey` and
`adminKey` must remain empty in committed configuration and private in any
local override.

## Known modernization inputs

- Express owns both transport and static hosting but no domain rule. #5 can
  replace it without treating its API implementation as authoritative game
  behavior, provided in-repo consumers migrate in the accepted slice.
- Zod owns two real boundaries: local configuration and generated model orders.
  #5 must decide whether those schemas migrate to current Zod or another
  approved boundary validator. Resolved: #5 selected Zod 4 as the validation
  library at every external/generated boundary (decision D6), and #6 upgraded
  the prototype to Zod 4.
- The rules, HTTP transport, model adapter, logging, and browser presentation
  are flat modules with direct coupling. The durable target boundary is a pure
  deterministic engine separated from those adapters.
- The current LLM adapter is text-generation-webui/OpenAI-compatible. Ollama is
  the target interface but is not a current dependency or runtime component.
- The prototype deviations listed in the README and roadmap are remediation
  inputs, not requirements to reproduce defects.

## Evidence commands

```powershell
node --version
npm --version
npm ls --depth=0
$env:NODE_OPTIONS = "--use-system-ca"
npm audit --json
'server.js', 'game.js', 'llm.js', 'config.js', 'logger.js', 'data.map.js', 'public/app.js' |
  ForEach-Object {
    node --check $_
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $_" }
  }
```

Issue #4 owned clean-install and end-to-end verification of the README's
disabled-LLM procedure after #3, #5, and #6 closed; the recorded evidence is in
[`milestone-0-closure.md`](milestone-0-closure.md).
