# Milestone 0 closure evidence

Closure date: 2026-08-24

Issue: [#4](https://github.com/AllenBurgett/shadow-theater/issues/4)

Milestone 0's exit conditions are met. The documented and dependency-modernized
prototype installs cleanly on the approved runtime, passes its syntax gate with
a clean dependency audit, binds only `127.0.0.1`, completes a disabled-LLM
`/api/new` and `/api/commit` turn against the deterministic staff planner, and
reproduces the sanitized `reference-001` capture from a clean revision. The
target foundation stack recorded on
[issue #5](https://github.com/AllenBurgett/shadow-theater/issues/5) was
written under Allen's 2026-08-23 overnight directive to finish Wave 1 —
authority to proceed, not an itemized ratification — so this document
initially recorded that condition as met provisionally. **Ratification
update:** on 2026-08-24 Allen ratified the whole decision record on issue #5,
on the recorded basis that every selection is backed by researched best
practice; the flagged calls **D2**, **D5**, **D8**, **D10** and **D15**
(including the D10/D15 roadmap-row deviations) are ratified with it. Every
Milestone 0 exit condition is now fully met and the Milestone 1
implementation gate is open.

## Exit conditions

Conditions are the roadmap's Milestone 0 "Closure" list.

| Exit condition | Status | Evidence |
|---|---|---|
| The binding brief is closed | Met | `001-loopback-binding` closed via [PR #1](https://github.com/AllenBurgett/shadow-theater/pull/1); re-verified by check 6a below |
| README and reference fixture exist | Met | [`README.md`](../README.md); [`fixtures/reference-001/`](../fixtures/reference-001/) and [`tools/capture-reference.mjs`](../tools/capture-reference.mjs) from [#3](https://github.com/AllenBurgett/shadow-theater/issues/3) via [PR #8](https://github.com/AllenBurgett/shadow-theater/pull/8) |
| Baseline checks and known deviations are recorded | Met | [`docs/prototype-baseline.md`](prototype-baseline.md) from [#2](https://github.com/AllenBurgett/shadow-theater/issues/2) via [PR #7](https://github.com/AllenBurgett/shadow-theater/pull/7); deviations per [Known deviations](#known-deviations-carried-into-milestone-1) below; this document records the checks |
| Allen has explicitly ratified the constitution | Met | Constitution v1.2.0 ratified 2026-07-18 |
| Allen has approved the stack decision | Met | The decision summary and Allen's ratification of 2026-08-24 on [#5](https://github.com/AllenBurgett/shadow-theater/issues/5); the full artifacts live in the intentionally untracked local `specs/001-foundation-stack/` directory (`specs/` is git-ignored by design) |
| Retained dependencies are current under that decision | Met | Express `^5.2.1`, Zod `^4.4.3`, `engines.node >=24` from [#6](https://github.com/AllenBurgett/shadow-theater/issues/6) via [PR #9](https://github.com/AllenBurgett/shadow-theater/pull/9); checks 1, 3 and 4 below |
| Issue #4 records all closure evidence on the approved runtime | Met | This document; every check below ran on Node `v24.15.0` |

No dependency finding was carried as accepted risk. The four advisories
inventoried by #2 were cleared by #6's upgrade rather than waived, so issue
#4's accepted-risk acceptance check is satisfied by absence of findings.

## Evidence

Every check below was run on 2026-08-24 from the repository root at the merge
of PR #9, with a clean working tree, on Node `v24.15.0` and npm `10.2.3`.

### 1. Runtime record

```powershell
node --version
npm --version
```

`node --version` printed `v24.15.0` and `npm --version` printed `10.2.3`, both
exit code 0. `package.json` declares `"engines": { "node": ">=24" }`, so the
runtime used for every check below satisfies the supported line approved in #5
and declared by #6.

### 2. Clean install

```powershell
Remove-Item node_modules -Recurse -Force
npm ci
```

`node_modules` was deleted first, so `npm ci` resolved the committed lockfile
from nothing:

```text
added 69 packages, and audited 70 packages in 747ms
found 0 vulnerabilities
```

Exit code 0.

### 3. Resolved direct dependencies

```powershell
npm ls --depth=0
```

```text
shadow-theater@0.1.0 E:\Code\shadow-theater
+-- express@5.2.1
`-- zod@4.4.3
```

Exit code 0. Both retained dependencies resolve to the versions #6 declared,
and Express resolves to `5.2.1` rather than the reverted `5.2.0` that D5
excludes. No dependency selected for replacement was upgraded.

### 4. Dependency audit

```powershell
npm audit
```

```text
found 0 vulnerabilities
```

Exit code 0. Unlike the #2 snapshot, this run needed no
`NODE_OPTIONS = "--use-system-ca"` workaround. The high `path-to-regexp`
finding and the three moderate `qs`/`body-parser`/`express` findings recorded
in [`docs/prototype-baseline.md`](prototype-baseline.md#read-only-security-inventory)
are gone.

### 5. Syntax gate

```powershell
'server.js', 'game.js', 'llm.js', 'config.js', 'logger.js', 'data.map.js', 'public/app.js' |
  ForEach-Object {
    node --check $_
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $_" }
  }
```

All seven modules, checked independently, returned exit code 0; the pipeline
threw nothing. `public/app.js` is included, as issue #4 requires.

### 6. Loopback binding and disabled-LLM API smoke

The server was started against a temporary configuration file outside the
repository — the same shape `tools/capture-reference.mjs` writes — so no
committed configuration, no ignored `config.local.json`, and no `logs/` output
was involved:

```json
{
  "server": { "port": 3000, "seed": "VESPERA-01" },
  "logging": { "enabled": false },
  "llm": { "red": { "enabled": false }, "gm": { "enabled": false } }
}
```

```powershell
$env:SHADOW_CONFIG = "<temporary path outside the repository>"
node server.js
```

Startup printed `Shadow Theater running on http://127.0.0.1:3000`,
`GAME_BUILD_ID=adv-legal-hardfix-2026-03-01c+endgame-2026-03-01a`,
`LLM_BUILD_ID=llm-redview-immutability-2026-03-01a`, and
`Logging enabled=false dir=./logs`. Nothing was written to stderr.

**6a — the listener is loopback-only.**

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
```

```text
LocalAddress LocalPort OwningProcess
------------ --------- -------------
127.0.0.1         3000         38640
```

One listening socket, bound to `127.0.0.1`. There is no `0.0.0.0` or `::` row.
A confirming probe against the machine's non-loopback address `172.27.0.1:3000`
failed with `Unable to connect to the remote server`, so PR #1's remediation
still holds.

**6b — `GET /api/version` succeeds locally.** HTTP 200:

```json
{"ok":true,"buildId":"adv-legal-hardfix-2026-03-01c+endgame-2026-03-01a","gameBuildId":"adv-legal-hardfix-2026-03-01c+endgame-2026-03-01a","llmBuildId":"llm-redview-immutability-2026-03-01a","node":"v24.15.0"}
```

**6c — `POST /api/new` with an empty JSON body.** HTTP 200:

```json
{"ok":true,"seed":"VESPERA-01","gameBuildId":"adv-legal-hardfix-2026-03-01c+endgame-2026-03-01a","llmBuildId":"llm-redview-immutability-2026-03-01a"}
```

`ok: true`, and the seed is the configured `VESPERA-01` rather than a default,
which confirms `SHADOW_CONFIG` selected the intended file instead of silently
falling back to schema defaults.

**6d — `POST /api/commit` with no BLUE operations.** HTTP 200, `ok: true`. The
response carried a four-line after-action report and the next BLUE view at
`turn: 2`, `seed: "VESPERA-01"`. The report opens
`Turn 1 adjudication:` followed by `RED: Advanced into R-10 (fort=0,
inSupply=false).` and `RED: Advanced into R-05 (fort=0, inSupply=false).` —
RED issued legal orders with `llm.red.enabled: false`, so they came from the
deterministic staff planner in `llm.js` without contacting any model service.
Both the README's documented body `{"blueOrders":{"operations":[]}}` and the
bare `{"blueOrders":[]}` form were exercised; each returned `ok: true` and
advanced the turn.

**6e — shutdown.** The listening process was stopped, and a re-query of
`Get-NetTCPConnection -LocalPort 3000 -State Listen` returned nothing, so the
port was released. Logging stayed disabled throughout, so the run added no
JSONL file.

### 7. Reference reproduction from a clean revision

```powershell
node tools/capture-reference.mjs --selftest
node tools/capture-reference.mjs --check
```

`--selftest` printed `selftest ok:` with the two positionally normalized rumor
identifiers `RED-RUMOR-2-NORM0` and `RED-RUMOR-3-NORM1`, exit code 0.

`--check` printed:

```text
reference-001 matches expected.json
```

Exit code 0. The helper started and stopped its own loopback server, drove the
four-turn `VESPERA-01` sequence, normalized the capture, and matched
`expected.json` byte for byte after normalization. The fixture therefore
describes the code at this revision, including the Express 5 and Zod 4 upgrade.

## Known deviations carried into Milestone 1

Milestone 0 records prototype defects; it does not fix them, and none of them
is a requirement for the replacement.

- The six numbered behaviors observed while capturing the reference sequence
  are in
  [`fixtures/reference-001/README.md`](../fixtures/reference-001/README.md#recorded-deviations).
- The ten prototype behaviors the reset must resolve, deliberately test, or
  explicitly discard are the bulleted list under "What the Prototype Proved" in
  the product roadmap.
- The seven user-facing limitations summarized for players are under
  [Known prototype limitations](../README.md#known-prototype-limitations).

These lists overlap deliberately: the fixture records what a run actually did,
the roadmap records what the reset owes a decision on, and the README records
what a person running the prototype today should expect.

## Follow-ups

- **Itemized ratification of the stack decision — resolved 2026-08-24.**
  Allen ratified the whole decision record on
  [issue #5](https://github.com/AllenBurgett/shadow-theater/issues/5), on the
  recorded basis that every selection is backed by researched best practice
  (the version-verification research of 2026-08-23, kept with the other
  stack-decision artifacts in the intentionally untracked local
  `specs/001-foundation-stack/` directory and summarized on issue #5). The
  Milestone 1 implementation gate is open; Milestone 1 proceeds through its
  own full-Specify artifacts using the ratified stack.
- **Prototype defect triage.** The deviations above are Milestone 1 inputs and
  need explicit resolve/test/discard decisions during the foundation spec, not
  incidental fixes.
