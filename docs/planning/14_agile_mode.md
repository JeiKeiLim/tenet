# 14 — Agile Mode

**Created**: 2026-04-28
**Status**: Design (locked, ready for implementation)
**Origin**: Obsidian inbox note `2026-04-21-tenet-agile-autonomous-loop-idea.md`
**Visual references**: `12_agile_mode_design.html` (static diagrams), `13_agile_mode_simulator.html` (interactive walkthrough)

---

## Motivation

Tenet's current autonomous loop runs end-to-end without user visibility. For 5–10 hour runs this is a feature — minimum interruption, maximum autonomy. But it has a real weakness: during the run, the user has no way to tell whether the implementation is going well, and no way to redirect cheaply if it isn't.

Agile mode is an **optional second mode** that trades autonomy for visibility and steerability. The cadence is modeled on a freelance agile team: agree on the design upfront, deliver one usable slice at a time, and let the client redirect at every checkpoint.

The current autonomous loop **stays the default**. Agile is opt-in.

## What this is NOT

- Not a replacement for autonomous mode.
- Not new infrastructure. Reuses every existing phase, every existing MCP tool, every existing artifact directory.
- Not runtime-only behavior. Decomposition produces a different DAG shape when `mode=agile`.
- Not auto-detected in v1. The user picks the mode after interview. Planner-detected oversize routing is future work.
- Not a new artifact lane. No `.tenet/agile/` directory. No `slice-manifest.md` file. The existing single-doc-per-artifact convention is sufficient.

---

## Design

### Mode flag

- New field on the spec: `mode: autonomous | agile`
- Picked once, after interview, before mockup
- Stored as a YAML-ish field at the top of `spec/{date}-{feature}.md`
- Decomposition reads the mode and shapes its output accordingly

### Decomposition output shape

| Mode | DAG shape |
|---|---|
| `autonomous` | Today's component DAG: `[auth] · [posts] · [friends] · [notifications] → [assemble] → [eval]` |
| `agile` | Sequence of usable slices, each itself a small DAG ending in a runnable + eval-passing app |

A slice = **one user-facing capability + everything needed to make it usable**. The planner is allowed and expected to bundle dependent sub-features when omitting them would leave the user with nothing to use (e.g., login alone is meaningless without signup, so slice 1 = login + signup).

Slicing is **additive**: slice 2 = slice 1 + posting; slice 3 = slice 1 + 2 + friends; etc. Not replacement (the bicycle metaphor was directional, not literal).

### Two checkpoint types

Agile mode introduces two distinct pause points. They are *not* "one checkpoint per slice."

**Initial plan-checkpoint** — once, after the upfront mockup pass:

- Mockup phase produces three views: final-product UI (the destination), architecture diagram (when scope warrants — initial pass always; redirects sometimes), and per-slice wireframes (the path).
- User confirms the entire planned product before any code is written.
- Adjust → re-mockup the affected slice (UI + architecture delta if relevant) → re-confirm.

**Use-checkpoint** — once per slice, after the slice's per-job eval passes:

- The app is running. The user actually runs and uses the new feature.
- Three actions: approve (build next slice), redirect (change something), done (stop).

A **mid-run plan-checkpoint reopens only when a redirect involves design change.** Pure reorders, no-ops, and structural changes go straight to the next build with no plan-checkpoint.

### Mockup phase covers UI + architecture

Mockup is not just UI wireframes. The phase produces architecture sketches whenever scope warrants:

- Initial whole-product pass: always includes architecture
- Mid-run mockup re-fire: includes architecture when the redirect introduces a new external service, a schema shift, or a structural change
- Pure visual tweaks: UI only

Architecture diagrams live in the same `mockup/{date}-{feature}.md` file, not in a new artifact lane. Architecture is also implicit in spec (data model section) and decomposition (DAG structure).

### Documentation: single doc per artifact, slice-headed sections inside

| Artifact | Today (autonomous) | In agile mode |
|---|---|---|
| `spec/{date}-{feature}.md` | One spec | Same file + `## Slice plan` section + `## Slice N: details` sections |
| `interview/{date}-{feature}.md` | One transcript | Same file + appended `## Slice N amendment` per redirect |
| `mockup/{date}-{feature}.md` | One mockup set | Same file + UI + architecture + per-slice sections, plus revision sections on amendment |
| `decomposition/{date}-{feature}.md` | One DAG | Same file + per-slice DAG sections appended |
| `harness/current.md` | Project singleton | Unchanged — accumulates as new env/services appear |
| `steer/inbox.md` | Project singleton | Unchanged |

`tenet_compile_context`'s "latest by date prefix" globbing still resolves to one file per artifact per feature. The agent reads the whole file and surfaces the right slice section.

### Redirect handling: reuse the readiness gate as the consistency check

After every redirect:

1. Apply the spec amendment (slice added / amended / reordered).
2. Run `tenet_validate_readiness` on the updated spec + harness + interview.
3. If **passed** → continue (build, or mockup→build for design-change redirects).
4. If **blocked** → map blockers to existing phases:

| Blocker category | Re-enter phase |
|---|---|
| missing user-facing info | mini interview (just for the gap) |
| missing or wrong design | mockup phase (UI + architecture if needed) |
| spec contradicts the redirect | spec amendment |
| harness gap (env / credentials / external service) | harness amendment + inline user prompt |
| architecture conflict (schema change, contradictory built code) | spec → mockup → decomposition (mini full-pass for the affected scope) |

5. Re-run `tenet_validate_readiness` after resolution. Loop until passed, then build.

This gives consistency-checking and conflict-resolution without inventing new tools or new doc lanes. The readiness gate's existing 8 categories already cover the surface where redirect-caused inconsistencies show up.

### Per-job eval is unchanged

Critic + test critic + playwright_eval fire on every job, just as in autonomous mode. Cost rises roughly N× (once per slice) — the trade-off that makes "user can actually use it" honest at every checkpoint.

---

## What's actually new (4 small additions)

1. **Mode flag on the spec**: `autonomous | agile`. Picked after interview, stored on the spec.
2. **Decomposition reads the mode** and produces a sliced DAG when agile, today's component DAG when autonomous.
3. **Two checkpoint types** in the orchestration: initial plan-checkpoint (once, after upfront mockup) and use-checkpoint (after each slice's eval). Mid-run plan-checkpoint reopens only on design-change redirects.
4. **Spec template gets a `## Slice plan` section** in agile mode. Bigger picture present from the start, evolves with feedback.

## What's reused (everything else)

- All 7 phases: interview · spec · mockup · harness · decomposition · execution · eval
- All 17 MCP tools — notably:
  - `tenet_init` — scaffold (unchanged)
  - `tenet_validate_clarity` — after interview (unchanged)
  - `tenet_compile_context` — each phase (unchanged; resolves the same single doc per feature)
  - `tenet_validate_readiness` — at the gate before build, plus after every redirect for consistency check
  - `tenet_register_jobs` — once per slice (current contract; just called more often)
  - `tenet_start_job` / `tenet_continue` — execution loop (unchanged)
  - `tenet_start_eval` — per job (unchanged)
  - `tenet_add_steer` / `tenet_process_steer` — redirect feedback channel
- SQLite state store, status writers, retry logic, orphan recovery
- Single feature-scoped doc per artifact (spec, interview, mockup, decomposition)
- Project-wide singletons (harness, steer)
- `{date}-{feature}.md` naming convention

---

## Implementation path

All 7 steps ship together. Order is smallest first — land in sequence, check in after each.

1. **Spec template change** — add `mode` field + `## Slice plan` section template (agile only). Documentation-only change to the spec phase prompt.
2. **Mockup phase prompt extension** — instruct it to produce final-product view + architecture diagram + per-slice path on the upfront pass; produce targeted UI/architecture deltas mid-run.
3. **Decomposition phase prompt** — when `mode=agile`, produce a slice sequence shape (each slice = small DAG ending in a runnable app) rather than component DAG.
4. **Plan-checkpoint mechanism** — new orchestration pattern in `skills/tenet/SKILL.md`: pause after mockup phase (agile mode only) until user confirms via steer or interactive prompt.
5. **Use-checkpoint mechanism** — pause after each slice's eval passes (agile mode only); wait for user input via steer or interactive prompt.
6. **Redirect router** — orchestration block: take user feedback at use-checkpoint, apply spec amendment, run `tenet_validate_readiness`, route blockers to the right phase to re-enter, re-run readiness until passed, then re-enter build for the affected slice. Required for the use-checkpoint to be useful — without it, redirects either get ignored or force a manual workflow.
7. **Status doc awareness** — `tenet_get_status` reads the spec's `## Slice plan` section to surface slice-level progress in `status/status.md`.

No new MCP tool. No new artifact directory. No new DB columns. The `feature` slug already in jobs implicitly tracks slice context via the in-progress section of the spec.

---

## Open questions resolved during alignment

| Question | Resolution |
|---|---|
| Slice semantics: replacement (bicycle→motorcycle→car) or additive? | **Additive.** Slice N = slice N-1 + new feature. Bicycle metaphor was directional only. |
| Slice planning: upfront or just-in-time? | **Whole plan exists upfront**, evolves with feedback. The user wants to see the bigger picture, not invent slice 4 only after slice 3 lands. |
| Single spec doc or per-slice files? | **Single doc** with internal slice-headed sections. Same for interview / mockup / decomposition. |
| Mockup once or per slice? | **Once upfront for the whole product** (final-product UI + architecture + slice path). Re-fires per slice only on design-change redirects. |
| One checkpoint per slice or two? | **Two distinct types**: initial plan-checkpoint (once) + use-checkpoint (per slice). Mid-run plan-checkpoint reopens only when redirect changes design. |
| Architecture diagram — separate phase? | **No.** Architecture lives in mockup phase. No new artifact. |
| How to detect inconsistency on redirect? | **Re-run `tenet_validate_readiness` on amended docs.** Map blockers to existing phases. |
| Auto-detect "too large for one autonomous run"? | **Punted to v2.** User-pick only in v1. |

---

## What's punted

- **Auto-detection of oversized requests** → v2. Needs a corpus of failures-from-oversize before a heuristic can be picked honestly.
- **Built-state awareness in readiness** (reading code in addition to docs) → revisit after v1 ships if redirects are slipping past the gate due to code-vs-spec drift. Cheapest first try: prompt-level hint passing already-completed slice list.
- **Conditional plan-checkpoint skip for trivial design changes** → v1 always shows plan-checkpoint when design changes. A "this is a one-line tweak, skip the checkpoint" optimization is a polish item, not a v1 requirement.

---

## Acceptance criteria

ACs 1–9 cover steps 1–5 (mode-aware planning + checkpoints). ACs 10–15 cover step 6 (redirect router). ACs 16–18 cover step 7 (status surfacing).

Cross-cutting invariants that hold across all steps:

- All artifacts continue to use the `{date}-{feature}.md` naming. Agile mode does not introduce a new directory under `.tenet/`.
- Per-job eval (critic + test critic + playwright_eval) fires on every job, in both modes.
- Autonomous mode flow stays byte-identical to today's behavior — no regressions in the default path.

### Steps 1–5: mode-aware planning + checkpoints

| # | Criterion | Test approach |
|---|---|---|
| AC1 | Spec template accepts `mode: agile \| autonomous`; missing field defaults to autonomous | Unit test on spec parser |
| AC2 | Spec with `mode: agile` includes a populated `## Slice plan` section the planner can read | Spec template fixture + parser test |
| AC3 | Decomposition prompt contains slicing instructions when `mode=agile`, component-DAG instructions when autonomous | Prompt-builder unit test |
| AC4 | Decomposition output parser accepts both DAG shapes (sliced + component) | Schema/parser test on fixture responses |
| AC5 | Mockup prompt requests final-product UI + architecture diagram + per-slice wireframes when `mode=agile` | Prompt-builder unit test |
| AC6 | Autonomous mode flow is byte-identical to today's behavior | Snapshot test on prompts + DAG output |
| AC7 | Initial plan-checkpoint blocks orchestration after upfront mockup; resumes on user confirm | Skill-flow integration test with MockAdapter |
| AC8 | Use-checkpoint blocks after each slice's per-job eval passes; approve / done / redirect each route correctly | Skill-flow integration test |
| AC9 | Per-job eval fires once per slice in agile mode (cost-multiplier expectation made explicit) | Job-count assertion in integration test |

### Step 6: redirect router

| # | Criterion | Test approach |
|---|---|---|
| AC10 | At use-checkpoint, user can submit redirect via `tenet_add_steer` (or interactive prompt); orchestrator picks it up and does NOT proceed to next slice | Skill-flow integration test |
| AC11 | Redirect text gets applied as a spec amendment (timestamped, slice-tagged section) before validation | File-state assertion |
| AC12 | `tenet_validate_readiness` runs on amended docs; blocker categories map 1:1 to the table above (missing info → mini interview, missing design → mockup, etc.) | Unit test on the router's blocker→phase function |
| AC13 | Resolution loop re-runs readiness until pass or explicit user abort; no infinite loop on unresolvable blockers | Bounded-retry test with cancel path |
| AC14 | After readiness passes, the orchestrator re-enters the build phase for the affected slice (not from scratch) | Skill-flow integration test |
| AC15 | Pure approve / done at use-checkpoint skips the readiness loop entirely (only redirects trigger it) | Skill-flow integration test |

### Step 7: status surfacing

| # | Criterion | Test approach |
|---|---|---|
| AC16 | When `mode=agile`, `status/status.md` includes a slice-level line ("Slice N of M in progress: <slice name>") above the existing job-level status | Snapshot test on status writer |
| AC17 | Slice progress is derived from the spec's `## Slice plan` section (total + names) plus job state (which slice's jobs are running / complete) | Unit test on the status reader given fixture spec + job state |
| AC18 | When `mode=autonomous` or absent, `status/status.md` output is unchanged from today | Snapshot test against today's output |

---

## References

- **Origin idea**: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyObsidian/03_Hermes/01_Working/Mira/00_Inbox/2026-04-21-tenet-agile-autonomous-loop-idea.md`
- **Static design sketch**: `docs/planning/12_agile_mode_design.html`
- **Interactive walkthrough**: `docs/planning/13_agile_mode_simulator.html`
- **Heavily reused**: `docs/planning/09_readiness_gate.md` — the readiness gate is the consistency check for redirects in this design.
- **Related project memory**: `~/.claude/projects/-Users-limjk-GitHub-JeiKeiLim-tenet/memory/project_tenet_open_ideas.md` — agile mode entry under "Active improvement."
