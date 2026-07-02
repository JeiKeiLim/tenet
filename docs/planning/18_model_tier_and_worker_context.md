# 18 — Model Tier & Worker Context

**Created**: 2026-07-02
**Status**: Design (ready for implementation)
**Origin**: Design discussion 2026-07-02. Evolved from `note.md` #9 (model-aware planning), #13 (weak-model critics), #21 (tenet rules in CLAUDE.md/AGENTS.md), plus a code investigation of the `tenet_compile_context` → worker wiring.
**Visual companion**: `18_model_tier_simulator.html` (open in a browser — interactive).

---

## TL;DR

Four **independent** work units. Ship U1 + U2 first (correctness fixes, immediate wins), then U3 (needs U1's worker-context hook), U4 anytime.

| Unit | What | Tier-link | New tool / DB? |
|---|---|---|---|
| **U1** | Fix the blind worker — inject `run_path` + exact `artifact_paths` + read-directive (+ migrate the report-only preamble) into the **worker dispatch path** | none (baseline) | no |
| **U2** | Reframe `tenet_compile_context` as the **orchestrator's** context aid (it never reached the worker); add an orchestrator role-preamble; fix docs that falsely claim worker delivery | none (robust constant) | no |
| **U3** | `model_tier` (local \| frontier) — interview decision; decomposition branches on it. **No persisted field** (the effect lives in the decomposition artifact) | yes (one consumer) | none — prompt-only (two skill-doc edits) |
| **U4** | Strengthen spec research (phase 02) + readiness gate — accuracy, not detailness | none | no |

---

## Problem statement (what the investigation found)

The worker subprocess **does not receive the compiled context.** Confirmed by reading the dispatch path end to end:

1. `tenet_compile_context` (`src/mcp/tools/tenet-compile-context.ts`) assembles spec + decomposition + project doctrine + harness + knowledge/journal/research/visuals **listings** and returns them via `jsonResult({ context })` — to the **orchestrator** (the host agent running the skill). It never writes onto the job.
2. `tenet_start_job` takes only `job_id` (`src/mcp/tools/tenet-start-job.ts`) — there is no parameter to pass context through.
3. `toInvocation` (`src/core/job-manager.ts:628`) reads `context = job.params.context` (`:635`) — and **nothing in the codebase ever sets `job.params.context`** (verified by grep; the only reader is `:635`, there is no writer). Not `tenet_register_jobs`, not retry, not anything.
4. All three adapters fall through to their `else` branch (`claude-adapter.ts:48`, `codex-adapter.ts:17`, `opencode-adapter.ts:17`) → the worker receives **only** `withDevPreamble(taskPrompt)` (`job-manager.ts:689`) — the Deliverable Requirements / Smoke Check / Git Commit / doctrine-drift boilerplate plus the job's task text.

**What the worker never sees:** spec, decomposition (DAG context / sibling-job rationale), project architecture/doctrine, harness, or even the run directory path — except a narrow mention of `${run_path}/journal/` that appears **only in the retry note** (`job-manager.ts:693,699`), only for failure logs.

**Second instance of the same bug:** the **report-only scope preamble** (`tenet-compile-context.ts:237–256`, inlined at `:269`) is instructions *for the worker* ("You are in REPORT-ONLY mode. You MUST NOT edit project files…") but it lives in `tenet_compile_context`, so it reaches the orchestrator, not the worker. Report-only workers are missing their scope instructions.

**Why runs have been fine anyway:** frontier on both ends. The orchestrator lived the context and self-serves by `Read`-ing files; the worker is usually frontier too, so it explores `.tenet/runs/<slug>/`, finds `spec.md`, and recovers. The gap is a **silent tax frontier pays and a catastrophic one a local/weak model pays** — which is exactly why surface this now, alongside the local-model work.

**The original sin:** the docs claim worker delivery that never happens:
- `skills/tenet/phases/04-decomposition.md:182` — "implementation workers read the same spec/harness/scenarios/interview/decomposition…"
- `skills/tenet/phases/05-execution-loop.md:164` — "tenet_compile_context prepends a Report-Only Scope preamble telling the worker…"

These must be corrected as part of U2, or we leave the same landmine that caused this investigation.

---

## Decisions and rationale (do not re-litigate without new evidence)

1. **`tenet_compile_context` stays, as the orchestrator's context aid.** Keep the name. It is a convenience aggregator (one call returns the assembled, drift-safe bundle via exact `artifact_paths`); the orchestrator could `Read` files itself but benefits from the call. Measured cost is acceptable (~5k words/run on real projects). It is **not** a worker-context mechanism and must stop being documented as one.

2. **Worker context is a separate mechanism, in the dispatch path.** Built server-side in `toInvocation` from the job's stored `run_path` + `artifact_paths`, set on `invocation.context` (the half-built bridge — adapters already prepend it). Do **not** route worker context back through `tenet_compile_context`, or we recreate the original confusion.

3. **`model_tier` is binary: `local | frontier`.** No middle tier — only Local and Frontier have been tested; a middle value is speculation (the user's own `note.md` #9 floated three, then retired it). Default/absent = `frontier` = today's behavior, byte-identical.

4. **`model_tier` modulates ONE thing: decomposition granularity (phase 04).** Worker context is uniform — spec + decomposition are inlined for every worker regardless of tier. The decomposition *content* already carries the tier signal (detailed for `local`, coarse for `frontier`), so inlining it always propagates the right detail for free — no second knob on the delivery mechanism. `model_tier` does not touch worker dispatch, jobs, spec, critics, or eval. (This dissolves the earlier "plan-detailness vs worker-hand-holding" conflation — was gap-review item 1, now resolved.) Spec strengthening (U4) is tier-independent.

5. **`model_tier` is static per run; the model running each role is a dynamic user choice.** The field is set once at planning. The frontier→local orchestrator handoff (a local model takes over the loop once planning is done) is a user-controlled runtime decision, not encoded in `model_tier`. The orchestrator can be a local model — so the role-preamble must be **robust by default**, strong enough to hold the weakest model that might orchestrate.

6. **`model_tier` is an interview decision, not a persisted field.** It is asked in the interview alongside `delivery_mode` (one post-interview checkpoint for both mode-like decisions), recorded in the interview transcript, and consumed once by decomposition. Unlike `delivery_mode` (read continuously across the run → needs a durable frontmatter handle), `model_tier` is read once, immediately, in the same session that asked it — so it is **not** stored as a field anywhere (no spec frontmatter, no job param, no DB column). Its effect lives in the decomposition artifact. The concept is capability-framed (local/frontier) for the interview/docs; since there is no persisted field, there is no field-name collision with the overloaded "mode" vocabulary — only consistent wording in the phase prompts.

7. **Orchestrator role-preamble is a runtime constant, not tier-modulated.** Robust-by-default (decision 5). `note.md` #21 (baking tenet rules into CLAUDE.md/AGENTS.md as system prompt) remains as the **heavy fallback** if the runtime preamble alone cannot hold a weak orchestrator — not built now.

8. **#13 (weak-model critics shallow-pass) stays parked.** Covered today by custom critics (`.tenet/critics.json`); future multi-model/dynamic critics will address it. Out of scope here.

---

## Work units

### U1 — Worker baseline context (ships first)

**Goal:** the worker knows where the run docs live and is told to read them, on every job, regardless of tier.

**Change:** in `toInvocation` (`src/core/job-manager.ts:628`), replace the dead `job.params.context` read with a server-side builder:

```
const context = this.buildWorkerContext(job);
```

`buildWorkerContext(job)` returns a `## Run Context` block assembled from the job's stored `run_path` + `artifact_paths` (spec/decomposition/harness), using the already-exported `readArtifactFile` (`src/mcp/tools/artifact-paths.ts`) — no duplication with compile_context. The baseline is **tier-independent and always inlines** the foundational planning docs (the worker is fresh-context and shouldn't have to explore for them): inline `spec.md` + `decomposition.md` + `harness.md` (small + universal); path-reference the bulky/selective ones (`journal/`, `research/`, `visuals/`). e.g.:

```
## Run Context
run_path: .tenet/runs/2026-07-02-user-auth
feature: user-auth

## Spec (inlined)
<spec.md contents>

## Decomposition (inlined — already tier-appropriate: detailed for local, coarse for frontier)
<decomposition.md contents>

## Harness (inlined)
<harness.md contents>

## Selective references (read if relevant)
journal/ · research/ · visuals/   (under run_path above)
```

Set this on `invocation.context` — all three adapters already prepend it (`claude-adapter.ts:48`, `codex-adapter.ts:17`, `opencode-adapter.ts:17`). No orchestrator change, no new tool.

**Migrate the report-only preamble:** move the Report-Only Scope block out of `tenet-compile-context.ts:237–256,269` into the worker dispatch path (a `report_only` branch in `withDevPreamble`, or in `buildWorkerContext`). It is worker-bound and currently lands on the orchestrator.

**Invariant:** every dispatched worker invocation carries `run_path` + **inlined** spec/decomposition/harness + path-refs to journal/research/visuals + a read directive; report-only workers additionally carry the Report-Only Scope block. **Identical shape for both tiers** — `model_tier` does not branch this.

**Tests:**
- FakeAdapter captures the dispatched prompt; assert it contains `run_path` + **inlined** spec/decomposition/harness contents + the read directive, for a registered dev job (same for both tiers).
- A `report_only: true` job's dispatched prompt contains the Report-Only Scope block.
- Default-path jobs (no tier) still pass existing tests (no regression).

**Tier-link:** none — this is the baseline.

---

### U2 — compile_context reframe + orchestrator role-preamble + doc fixes (independent)

**Goal:** make `tenet_compile_context`'s stated purpose match reality (orchestrator aid), and re-assert orchestrator discipline every cycle.

**Change A — role-preamble at top of output.** In `tenet-compile-context.ts`, prepend a constant block above `# Compiled Context`:

> **You are the orchestrator, not the worker.** Do not implement code directly. Every implementation action goes through `tenet_start_job`. If you are unsure of the loop rules, re-read the current phase file (`phases/05-execution-loop.md`) before acting.

Robust enough for a local orchestrator (decision 5). It fires once per cycle, right before dispatch — the moment the orchestrator is tempted to "just fix it myself."

**Change B — doc fixes (mandatory).**
- `skills/tenet/phases/04-decomposition.md:182` — rewrite "implementation workers read…" to "this assembles the **orchestrator's** working context; workers receive their own context via the dispatch path."
- `skills/tenet/phases/05-execution-loop.md:164` — the Report-Only Scope preamble now lives in the worker dispatch path, not compile_context.
- `skills/tenet/SKILL.md` invariant #2 ("Context is compiled per job…") — keep, re-rationale as orchestrator context.
- `CLAUDE.md` — update the "Deliverable Requirements preamble" note to mention it now carries `run_path`/`artifact_paths` (U1) and that compile_context is the orchestrator's aid.
- After U1's migration: remove the report-only preamble block from `tenet-compile-context.ts`.

**Invariant:** `tenet_compile_context` return begins with the role-preamble and contains no worker-bound instructions.

**Tests:** compile_context return starts with the role-preamble; no `report_only` block in its output after migration.

**Tier-link:** none.

---

### U3 — model_tier (prompt-only, independent)

**Goal:** let the run declare its executioner tier so decomposition adapts.

**No persisted field.** `model_tier` is an **interview decision**, consumed once by decomposition:
- **Asked in the interview** (phase 01) alongside `delivery_mode`.
- **Recorded in the interview transcript** (`.tenet/runs/<slug>/interview.md`) — already a persisted run artifact.
- **Consumed once by decomposition** (phase 04): read from session context, or re-read from the transcript if compaction fired between interview and decomposition. `local` → detailed DAG (many small, single-responsibility jobs, explicit per-job acceptance criteria); `frontier` → today's goal-oriented DAG.

Why no field: it is read **once, immediately after it is asked, in the same session** that holds the interview answer. Contrast `delivery_mode`, which is read continuously (every slice, redirect router, status) and so genuinely needs a durable frontmatter handle. `model_tier`'s effect is captured in the **decomposition artifact** (detailed vs coarse), which is what downstream actually consumes — the decision itself does not need to persist separately.

**No TypeScript code change for `model_tier`** — two skill-doc edits: phase 01 asks the question, phase 04 branches on the answer. No frontmatter field, no job param, no dispatch read, no DB column.

**Invariant:** `frontier` (or absent) → decomposition instructions byte-identical to today.

**Tests / verification:**
- Skill-doc review: phase 04 contains tier-conditional decomposition instructions.
- Real-run watch (consistent with other recently-shipped prompt-level work): confirm a `local`-tier run produces a finer-grained DAG than `frontier`.

**Tier-link:** yes — single consumer (decomposition). Independent of U1 (worker context is uniform).

**Composes with agile mode:** a run may be `delivery_mode: agile` + `model_tier: local`; decomposition then reads both fields (sliced + detailed). Add a composition test.

---

### U4 — Spec research strengthening (independent)

**Goal:** more accurate specs — benefits every tier, every run.

**Change:** strengthen the phase-02 spec-writing prompt for **research accuracy** (verify claims against the actual codebase; cite real files), and strengthen `tenet_validate_readiness`'s spec-completeness checks (the gate that refuses to let a thin spec through to decomposition).

**Why both:** prompt = the instruction, gate = the verification, pointing at one contract. A raised gate without the strengthened prompt fails incoherently; a strengthened prompt without the gate is advisory. Since spec-writing runs on a frontier model, there is no over-constraint risk.

**Invariant:** a spec that passes the strengthened gate demonstrably cites real project files/structure.

**Tests:** readiness gate rejects a placeholder/vague spec fixture that the old gate accepted.

**Tier-link:** none.

---

## Gap review (seams, assumptions, deferred)

1. ~~`model_tier` conflates "plan detailness" and "worker needs hand-holding."~~ **Resolved** — worker context is now uniform (always inline), so `model_tier` has a single effect (decomposition granularity). No conflation, no second knob.
2. **`model_tier` static vs role-model-choice dynamic** — do not couple them (decision 5). The role-preamble is robust regardless of which model orchestrates.
3. **Two context consumers, one artifact-reader helper** — orchestrator via `tenet_compile_context`, worker via `toInvocation`/`buildWorkerContext`, both reuse `readArtifactFile`. Keep the paths separate.
4. **Composes with agile mode** (two decomposition modifiers). Low risk; add a composition test.
5. **#21 (CLAUDE.md/AGENTS.md system-prompt rules)** — heavy fallback if U2's runtime preamble can't hold a weak orchestrator. Triggered only if observed, not built now.
6. **#13 (weak-model critics)** — parked; custom critics today, multi-model/dynamic critics later.
7. **Naming** — `model_tier: local|frontier` collides with nothing. `tenet_compile_context` keeps its name.

---

## Non-goals

- A third (middle) model tier.
- Routing worker context through `tenet_compile_context`.
- Renaming `tenet_compile_context`.
- Per-stage / per-critic model selection or a tier→model binding (#24, #25) — `model_tier` sets plan granularity only; it does not select a model.
- Auto-detecting the actual worker model — `model_tier` is a **declaration** (asked in interview), not a detection. Tenet tracks the adapter (which CLI) via `default_agent`/`agent_override`, never the model. Worker context is built *before* execution, so it can only rely on the declaration; detection from worker output would arrive too late to shape that job's context.
- #13 critic-capability work.

---

## Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| AC1 | A dispatched dev worker's prompt contains `run_path` + **inlined** spec/decomposition/harness + path-refs + read directive | FakeAdapter prompt assertion |
| AC2 | A `report_only` worker's prompt contains the Report-Only Scope block; compile_context output does **not** | both assertions |
| AC3 | compile_context return begins with the orchestrator role-preamble | unit test |
| AC4 | Docs (`04:182`, `05:164`, SKILL invariant #2, CLAUDE.md) describe compile_context as orchestrator aid and worker context as separate | review |
| AC5 | `model_tier` absent or `frontier` → decomposition prompt + worker context byte-identical to today | snapshot test |
| AC6 | phase-04 decomposition instructions branch on executioner tier (detailed for `local`) | skill-doc review + real-run watch |
| AC7 | `model_tier` is an interview decision; **no persisted field** anywhere (not spec frontmatter, not jobs, not DB) | skill-doc review |
| AC8 | agile + local composes (sliced + detailed decomposition) | composition test |
| AC9 | Strengthened readiness gate rejects a vague/placeholder spec the old gate accepted | fixture test |

---

## Sequence

1. **U1** (worker baseline context + report-only migration) — correctness, immediate.
2. **U2** (compile_context reframe + role-preamble + doc fixes) — correctness, independent; can land with U1.
3. **U3** (`model_tier`) — prompt-only (phase 01 asks, phase 04 branches); independent of U1.
4. **U4** (spec strengthening) — independent, anytime.

All four are independently shippable. No DB migration, no new MCP tool, no breaking change to the default path.

---

## References

- Code: `src/core/job-manager.ts` (`toInvocation:628`, `withDevPreamble:689`), `src/mcp/tools/tenet-compile-context.ts`, `src/mcp/tools/artifact-paths.ts` (`readArtifactFile`), `src/mcp/tools/tenet-register-jobs.ts`, `src/adapters/{claude,codex,opencode}-adapter.ts`.
- Skills: `skills/tenet/phases/02-spec-and-harness.md` (`delivery_mode` precedent), `04-decomposition.md`, `05-execution-loop.md`, `skills/tenet/SKILL.md`.
- Prior art: `docs/planning/14_agile_mode.md` (same prompt-driven, no-new-tool pattern; `delivery_mode` field precedent).
- `note.md` open items this advances/addresses: #9 (model-aware planning), #21 (runtime portion), and surfaces the wiring gap behind #13's "blind execution" observation.
