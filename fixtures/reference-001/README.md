# Reference sequence `reference-001`

A small, sanitized, repeatable record of what the prototype actually does on a
fixed seed with the RED LLM disabled. It exists so Milestone 1 engine work can
decide which prototype behavior to preserve and which to replace deliberately.

It is **not** a specification. Where the recorded behavior is wrong, it is listed
under [Recorded deviations](#recorded-deviations) rather than treated as a
requirement.

## Files

| File | Purpose |
|---|---|
| `sequence.json` | The seed and the ordered BLUE requests, with the intent behind each turn |
| `expected.json` | The normalized, sanitized capture that a rerun must reproduce |
| `../../tools/capture-reference.mjs` | Captures, normalizes, sanitizes, and compares |

## Capture and compare

The helper starts its own loopback server with the RED LLM profile and logging
disabled, drives the sequence, then stops the server. It never contacts a model
service and never writes to `logs/`.

```powershell
node tools/capture-reference.mjs --check
```

`--check` recaptures and compares against `expected.json`, exiting non-zero and
printing the first differing lines on drift. Other modes:

- `--write` — overwrite `expected.json` from a live run. Use only when a change
  to recorded behavior is intended, and say why in the commit message.
- `--print` — capture to stdout without writing.
- `--selftest` — check the rumor-id normalizer without starting a server.

Set `REFERENCE_PORT` if 3117 is in use.

## What the sequence does

Seed `VESPERA-01`, four turns, RED driven by the deterministic staff planner:

1. One operation from each effect family — deception, counter-deception,
   fortification, presence movement — spending the full 10 CP.
2. Link interdiction and jamming, then a deliberate budget overrun.
3. A second rumor, a friendly-territory counterintel sweep, another redeploy.
4. No BLUE operations, so the turn is driven entirely by RED and the decay path.

BLUE deliberately never attacks `R-04`. Taking it completes BLUE's public
objective set, which ends the game during turn 1 and leaves nothing to compare.

## Retained fields and why

Everything below is compared. Fields not listed are omitted as noise.

| Field | Comparison purpose |
|---|---|
| `gameBuildId`, `llmBuildId` | Revision provenance; a change means the fixture describes different code |
| `steps[].blueOrders` | The exact request that produced the outcome |
| `steps[].aar` | The authoritative adjudication narrative, including which orders were applied or silently dropped |
| `blueView.turn`, `.seed` | Turn advance and seed propagation |
| `blueView.resources` | CP, ISR, and political capital movement |
| `blueView.hand` | Deterministic per-turn hand generation |
| `blueView.legalTargetsByCard` | Order legality, the rule surface most likely to change in the reset |
| `blueView.objectives` | Seeded objective text and the constraint line |
| `blueView.regions` | Control, fort, unrest, supply, friendly presence, and the fog-shaped enemy estimate |
| `blueView.links` | Capacity and the interdiction/jamming timers |
| `blueView.rumors` | Deception contacts visible to BLUE, with identifiers normalized |
| `blueView.completedObjectives`, `.gameOver` | Objective scoring and end-condition evaluation |
| `blueView.meta.advance*` | The advance-legality diagnostic the prototype already self-checks |

Omitted deliberately:

- `redView` from every `/api/commit` response — it carries RED's fog-of-war state
  and RED's secret objectives.
- Region `name`, `x`, `y` and the `cards` catalogue — static decoration that
  repeats every turn and would triple the file without adding signal.
- `node` process version from `/api/version` — machine-specific, not behavior.
- Log files and the in-memory tail — logging stays disabled for the capture.

## Normalization

Rumor identifiers are the only volatile field in the game path. `game.js` builds
them as `<SIDE>-RUMOR-<turn>-<Math.random()>`, so they differ on every run. The
helper sorts rumors deterministically and replaces the random suffix with a
positional `NORM<n>`. Prototype behavior is unchanged; only the record is
normalized.

The live sequence does not currently surface a rumor in the BLUE view: BLUE
cannot see its own rumors, and the RED staff planner spends its whole budget on
advances, so it never plays `SPOOF_CONTACTS`. The normalizer is therefore proven
by `--selftest` rather than by the capture. If a future sequence makes RED spoof,
the normalizer is already in the path.

## Recorded deviations

Behavior observed while capturing this fixture. These are inputs for Milestone 1
remediation, not requirements to reproduce.

1. **Two BLUE objectives complete before the first order resolves.**
   `OBJ-B-PUB-2` ("Keep at least 1 PORT controlled through Turn 8") only checks
   the turn number and current control, with no persistence tracking, and BLUE
   starts holding the port `R-01`. `OBJ-B-SEC-2` ("Reduce Red presence below 30
   in any INDUSTRY region") is satisfied because `R-07` starts at zero RED
   presence. BLUE therefore begins at 10 of the 12 points needed to win.
2. **Objective completion is not sticky.** RED's score across the four turns is
   0, 4, 0, 6 — completion is recomputed from current state each turn, so it can
   be lost again. Consecutive-turn requirements are not tracked at all.
3. **Jamming has no side ownership.** On turn 2 BLUE jams `L-01-07`, and that
   completes RED's secret objective `OBJ-R-SEC-1` ("Maintain jammed status on a
   link"), because the check asks only whether any link is jammed.
4. **Budgeting stops at the first over-budget operation.** On turn 2 the
   `SECURE_CORRIDOR` order takes the running total to 11 of 10 CP and is
   rejected — and so is the trailing 2 CP `FOCUSED_ISR_SWEEP`, which would have
   fit in the remaining budget. Three of five submitted operations apply.
5. **BLUE's after-action report names RED's operations verbatim**, including
   targets, and the browser renders it (`public/app.js:121`). A commander sees
   exactly what the enemy did each turn.
6. **BLUE's view reports RED's completed secret objective identifiers.** The
   prototype returns them in `completedObjectives.red` and `gameOver.completed`.
   The helper strips them from the fixture and records only a count; the leak
   itself remains in the prototype.

## Scope note

This fixture adds no npm script. `package.json` is owned by issue #6; wiring a
command is a manifest change that belongs there or in the Milestone 1 test setup.
