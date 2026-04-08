---
name: tenet
description: >
  Long-running autonomous development orchestration for 12+ hour runs.
  Trigger when user asks to: build/refactor/fix software end-to-end, run autonomously,
  execute a dependency graph, continue work without constant interaction, use
  full/standard/quick Tenet execution modes, or steer an ongoing autonomous run.
  Also triggers on: 'tenet', 'autonomous loop', 'long run', 'keep going',
  'run overnight', 'execute the plan', 'start building'.
allowed-tools:
  # Tenet MCP tools (the engine)
  - tenet_init
  - tenet_continue
  - tenet_compile_context
  - tenet_start_job
  - tenet_register_jobs
  - tenet_job_wait
  - tenet_job_result
  - tenet_cancel_job
  - tenet_start_eval
  - tenet_validate_clarity
  - tenet_update_knowledge
  - tenet_process_steer
  - tenet_health_check
  - tenet_get_status
  - tenet_set_agent
  # Host agent tools (used during crystallization phase)
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Tenet Skill — Autonomous Development Loop Brain

Execute this file as an operational program. Be decisive, deterministic, and checkpoint-driven.

## Core invariants (never violate)

1. Fresh session per job is default defense against compounding errors.
2. Context is always compiled per job (`tenet_compile_context`), never raw file dumps.
3. Generation and validation are separated (author flow vs critic flow).
4. Harness enforcement is mandatory in **all** modes.
5. Persistent human-readable state lives in `.tenet/` markdown files.
6. Operational runtime state is MCP server SQLite; do not manually manage runtime IDs.
7. Use server-side continuation (`tenet_continue()`), not ad-hoc ID reconstruction.
8. Keep wrong turns in active job context (within that session) to prevent repetition.
9. Purpose alignment outranks narrow spec checkboxing.
10. All knowledge writes are confidence-tagged.

## Boot sequence (must run on skill load)

The MCP server is auto-started by the host platform via project config files
(`.mcp.json` for Claude Code, `opencode.json` for OpenCode). These are created
by `npx tenet init`. No manual server launch is needed.

1. Ensure Tenet project state exists:
   - Call `tenet_continue()`.
   - If no active Tenet state exists, call `tenet_init(project_path=".")`.
2. Verify MCP health:
   - Call `tenet_health_check()`.
3. If health check fails (MCP server unreachable):
   - Tell the user: "Tenet MCP server is not running. Run `npx tenet init` in the project root, then restart your agent."
   - Do not attempt to self-heal — the platform manages MCP server lifecycle.
4. Read current state summary:
   - Call `tenet_get_status()`.
5. **Detect brownfield project** (existing codebase without prior Tenet state):
   - If `.tenet/` was just created (fresh init) AND the project directory contains existing source code (look for `src/`, `lib/`, `app/`, `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, or similar), this is a **brownfield project**.
   - **Read `phases/00-brownfield-scan.md` and execute the codebase scan** before proceeding to any mode selection or crystallization phase.
   - The scan produces `.tenet/bootstrap/codebase-scan.md` — a structured summary of the existing codebase that feeds into interview and spec phases.
   - If `.tenet/` already existed (resuming), skip the scan.

Do not proceed into execution until health is good.

## Scale-adaptive mode selection

Choose exactly one mode at start; re-evaluate at major scope changes.

### Signals

- Scope signals: cross-module impact, likely file count, interface surface area.
- Complexity signals: ambiguity, unknowns, requirement volatility.
- Context readiness signals: existing `.tenet/` harness/spec quality.

### Mode rules

#### Full mode (default for significant work)

Use when: new feature with unclear edges, major refactor, greenfield, broad multi-module change.

Flow:
1. Interview (Socratic + ontological)
2. Spec + Harness
3. Visual artifacts
4. DAG decomposition
5. Autonomous execution loop

#### Standard mode

Use when: medium complexity, known architecture, moderate unknowns.

Flow:
1. Brief clarification
2. Quick spec + harness confirmation
3. Execution loop

#### Quick mode

Use when: small isolated bug/config/content tweak with low ambiguity.

Flow:
1. Direct execution with harness enforcement
2. Minimal docs/status updates

Mode affects planning overhead only. Evaluation gates remain enforced.

## Full-mode crystallization phase

Run before decomposition when in Full mode. Each step below requires reading a detailed reference doc FIRST. Do NOT skip the read — the reference contains exact file paths, formats, and enforcement rules that this summary omits.

### A) Interview protocol (includes clarity gate)

**Read `phases/01-interview.md` before executing.**

- Use Socratic questions to expose assumptions, intent, and constraints.
- Use ontological questions to separate root causes from symptoms.
- MUST ask at least one question from each of the 8 mandatory categories.
- MUST use interactive prompts (question dialog/modal) to ask questions — do NOT dump questions as inline text. Ask one question at a time and wait for the user's answer.
- MUST write transcript to `.tenet/interview/{date}-{feature}.md` (e.g. `2026-04-08-oauth.md`). Derive the feature slug from the user's project description early in the interview.
- MUST call `tenet_validate_clarity()` to get an independent clarity score.
- Wait for the validation result via `tenet_job_wait` + `tenet_job_result`.
- If Clarity < 0.8: address the gaps identified in the validation result, then re-validate.

Do NOT self-score the interview. The validation must come from a separate agent context.
Do NOT re-validate clarity after the interview — later phases have their own validation.

### B) Visual artifact generation

**Read `phases/03-visuals.md` before executing.**

- Generate self-contained HTML artifacts under `.tenet/visuals/`.
- Architecture diagrams MUST use SVG elements with connection arrows — not just styled CSS boxes.
- For UI-facing work, generate 3-5 materially different mockups.
- Present visuals to user for approval before proceeding.

### C) Scenario + anti-scenario criteria

- Define concrete success scenarios.
- Define explicit anti-scenarios (failure shapes to avoid).
- Write to `.tenet/spec/scenarios-{date}-{feature}.md`.
- These become evaluation inputs.

### D) Spec + Harness generation

**Read `phases/02-spec-and-harness.md` before executing.**

- Write spec to `.tenet/spec/{date}-{feature}.md` (NOT `.tenet/spec.md` or `.tenet/spec/spec.md`).
- Update harness at `.tenet/harness/current.md` (NOT `.tenet/harness.md`).
- Write scenarios to `.tenet/spec/scenarios-{date}-{feature}.md`.
- Lock harness invariants after agreement.

### E) DAG decomposition

**Read `phases/04-decomposition.md` before executing.**

- Write decomposition to `.tenet/decomposition/{date}-{feature}.md` (NOT `.tenet/spec/decomposition.md`).
- Status files (`job-queue.md`, `status.md`) are auto-generated from the DB on state transitions.
- Call `tenet_register_jobs` to load the DAG into the runtime queue.
- Do NOT start execution until all status files are populated AND jobs are registered.

## Standard-mode prep

1. Brief clarification to resolve top unknowns.
2. Generate/update concise spec slices and acceptance criteria.
3. Confirm or refine harness constraints.
4. Decompose only if needed; single-job execution is allowed.

## Quick-mode prep

1. Confirm task is truly isolated and low ambiguity.
2. Confirm harness coverage for touched area.
3. Skip interview/spec/decomposition overhead.

## Pre-execution confirmation gate

Before entering the autonomous execution loop, present the user with a summary for confirmation:

1. Display: mode, total jobs from DAG, key spec decisions, harness constraints.
2. Ask: "Ready to start autonomous execution? This will dispatch {N} jobs. [Confirm / Adjust / YOLO mode]"
3. If user confirms → proceed to execution loop.
4. If user adjusts → apply changes, update docs, re-confirm.
5. If user selects YOLO mode → skip all future confirmation gates for this run.

Skip this gate ONLY if the user has explicitly requested YOLO mode or said "just do it" / "start building" without wanting oversight.

## Core autonomous loop (all modes)

**Read `phases/05-execution-loop.md` before executing. It contains the exact tool call sequence with concrete examples.**

Use this control flow exactly. Worker execution is performed by MCP-dispatched agents; orchestrator only uses `tenet_*` tools. Do NOT call subagents directly — use `tenet_start_job` to dispatch all work.

`tenet_continue()` returns the next actionable job from the DAG and current session state. The server tracks what's done, what's blocked, and what's ready.

**CRITICAL: Non-blocking execution.** `tenet_job_wait` must be dispatched as a **background task** (not foreground). This keeps the orchestrator available for user interaction and steer messages while jobs execute.

```python
# jobs_completed_since_last_health = 0

while True:
    # 1. Steering checkpoint
    steer = tenet_process_steer()
    IF steer.has_emergency:
        HALT — cancel active jobs, process emergency, wait for user
    IF steer.has_directive:
        apply directive (reorder queue, add/remove jobs, update spec)

    # 2. Get next job from server-managed DAG
    continuation = tenet_continue()
    IF continuation.all_done:
        BREAK — run complete
    IF continuation.all_blocked:
        BREAK — report blocked jobs, wait for user steer

    job = continuation.next_job

    # 3. Compile bootstrap context for this job
    compiled_context = tenet_compile_context(job_id=job.id)

    # 4. Dispatch registered job for execution
    run = tenet_start_job(job_id=job.id)

    # 5. Brief user and start background status check
    TELL USER: "Dispatched: {job.name}. I'll monitor in the background."
    TELL USER: "You can send messages or steer directives while this runs."
    check = BACKGROUND tenet_job_wait(job_id=run.job_id)

    # 6. When background check returns (instant — no blocking):
    #    - If is_terminal=false: check steer, brief user, wait, then re-check
    #    - If is_terminal=true: proceed to result collection
    #    Wait strategy: start at 30s, increase by 1.5x each cycle, cap at 120s
    poll_delay = 30
    WHILE check result is not terminal:
        result = COLLECT check
        tenet_process_steer()
        TELL USER: "{job.name}: {result.progress_line}"
        SLEEP poll_delay seconds
        poll_delay = min(poll_delay * 1.5, 120)
        check = BACKGROUND tenet_job_wait(job_id=run.job_id, cursor=result.cursor)

    # 7. Retrieve full output
    output = tenet_job_result(job_id=run.job_id)

    # 8. Dispatch evaluation (author + critic)
    eval = tenet_start_eval(job_id=job.id, output=output)
    # This dispatches TWO jobs: author_eval and critic_eval
    author_check = BACKGROUND tenet_job_wait(job_id=eval.author_eval_job_id)
    critic_check = BACKGROUND tenet_job_wait(job_id=eval.critic_eval_job_id)

    # Wait for both eval jobs
    eval_delay = 30
    WHILE author_check or critic_check not terminal:
        SLEEP eval_delay seconds
        eval_delay = min(eval_delay * 1.5, 120)
        # Re-check whichever is not done
        IF author_check not terminal:
            author_check = BACKGROUND tenet_job_wait(job_id=eval.author_eval_job_id)
        IF critic_check not terminal:
            critic_check = BACKGROUND tenet_job_wait(job_id=eval.critic_eval_job_id)

    author_output = tenet_job_result(job_id=eval.author_eval_job_id)
    critic_output = tenet_job_result(job_id=eval.critic_eval_job_id)

    # 9. Act on eval results — BOTH must pass
    IF author_output.passed AND critic_output.passed:
        tenet_update_knowledge(job_id=job.id, findings=output.findings)
    ELSE:
        run_reflection(job, output, author_output, critic_output)

    # 10. Post-job steering checkpoint
    tenet_process_steer()

    # 11. Periodic health audit (every 3 completed jobs)
    jobs_completed_since_last_health += 1
    IF jobs_completed_since_last_health >= 3:
        tenet_health_check()
        jobs_completed_since_last_health = 0
```

**Key difference from a blocking loop:** Each `tenet_job_wait` is dispatched as a background task. When it returns, the host fires a notification. Between notifications, the user can interact with the orchestrator. The orchestrator checks steer messages on each notification cycle.

## Bootstrap compiler contract

Before every job, `tenet_compile_context(job_id)` must produce a compiled view pipeline:

1. Relevance filter (job-targeted)
2. Recency filter
3. Interface extraction from decomposition state
4. Confidence-prioritized knowledge filtering
5. Steer integration (context-class messages for this job)
6. **Todo recitation at end** (objective + checklist + risks)

Never bypass compiled context.

## Evaluation pipeline (5 stages)

**Read `phases/06-evaluation.md` before executing. It contains exact stage definitions, output format, and the author/critic separation rules.**

Evaluate every completed job using staged gates:

### Stage 1 — Mechanical

- Lint, build, type-check, tests (including acceptance tests if they exist).
- Any failure: fail eval.

### Stage 1.5 — Smoke Check (mandatory for dev jobs)

- Start the server/app and verify it actually works at runtime.
- API: hit endpoints, verify non-5xx responses.
- Frontend: navigate pages, verify rendering.
- A smoke check failure = Stage 1 failure. The feature must work, not just compile.

### Stage 2 — Property-based

- Run property tests from pre-declared harness/spec properties.
- Properties must predate implementation.

### Stage 3 — Spec compliance (author context)

- Validate acceptance criteria and scope integrity.
- Check doc-code sync claims.

### Stage 4 — Purpose alignment (critic context)

- Separate context from author reasoning.
- Inputs: spec/scenarios/anti-scenarios/harness/reference visuals + diff.
- Apply zero-findings critic rule:
  - If zero findings, force re-analysis from alternate attack angle.

### Stage 5 — Structured self-questioning

Question categories:
- Edge cases
- Error paths
- Integration boundaries
- User-visible behavior
- Security
- Performance
- Purpose alignment

Unanswerable questions become follow-up tasks or steering requests.

## Confidence-tagged knowledge writes

Every knowledge update via `tenet_update_knowledge` must tag findings with one of:

| Tag | Meaning |
|-----|---------|
| `[implemented-and-tested]` | Code exists and passes tests |
| `[implemented-not-tested]` | Code exists but tests are missing or incomplete |
| `[decision-only]` | Agreed approach, not yet coded |
| `[scanned-not-verified]` | Extracted from existing code during brownfield scan, not validated |

Downstream jobs weight information by confidence. A `[decision-only]` entry is a plan, not a fact.

## Cascade checks (three types)

Run cascade checks when upstream state changes:

### Type 1 — Document-to-document alignment

- Trigger: any upstream doc update
- Check: do interview ↔ spec ↔ harness contradict each other?
- Method: load both docs, diff key claims, flag contradictions

### Type 2 — Code-to-document alignment

- Trigger: after every completed job
- Check: does the knowledge doc match what code actually does?
- Method: load doc + relevant code, compare

### Type 3 — Trajectory-to-purpose alignment (drift detection)

- Trigger: every 3 completed jobs
- Check: is the project still heading toward the original goal?
- Method: summarize recent changes, compare against purpose + scenarios

## Eval failure handling

On eval fail, run reflection before retry:

1. Root cause (why this failed, not just what failed)
2. At least two alternative approaches
3. Recommended next approach
4. Pattern match against prior lessons

Then retry under stagnation and safety gates.

## Stagnation detection and persona rotation

Detect stagnation signals:

- Same failing test N times
- Edit-revert cycles in same area
- Repeated rereads without new decisions
- Repeated identical tool-call patterns

If stagnating, rotate persona in order:

1. Hacker
2. Researcher
3. Simplifier
4. Architect
5. Contrarian

After full rotation, allow at most 2 additional attempts. If still blocked, halt job and require steer input.

## Async user steering protocol

Process steer at every checkpoint via `tenet_process_steer()`.

Message classes:

- default: context
- `DIRECTIVE:` priority/order/scope changes
- `EMERGENCY:` immediate halt and containment

Track inline status lifecycle in steer docs:

`received -> acknowledged -> acted_on -> resolved`

Never leave messages silently unacknowledged.

## Safety and resilience gates

Always enforce:

1. **Staleness detector**: repeated no-improvement cycles trigger persona rotation, then halt.
2. **Max consecutive failures**: cap retries per job (default 3), then mark blocked, move to next independent job.
3. **Degradation-driven checkpointing**: when a worker reports quality signals declining (repeated failures, circular edits, repeated rereads), the MCP server triggers a session checkpoint-and-restart.
4. **In-session checkpoint protocol** (executed by worker agents):
   - Write progress snapshot: what's done, what's remaining, key decisions
   - Terminate degraded session cleanly
   - Start fresh session with ONLY: progress snapshot + original job spec + harness
   - Continue from snapshot (clean context, recovered reasoning quality)
5. **Danger zone enforcement**: if a worker touches a harness danger zone path, the MCP server halts the job, reverts the change, and raises an emergency steer.

If emergency safety breach occurs, cancel active jobs via `tenet_cancel_job` and process steer.

## State management contract

- `.tenet/` markdown = persistent project memory and management layer.
- MCP SQLite = runtime state (jobs/events/cursors/heartbeats/concurrency).
- Orchestrator must not implement custom runtime state tracking beyond tool outputs.

## Agent routing and runtime adjustments

When needed (rate limits, capability mismatch, policy change), switch assignment:

- `tenet_set_agent(job_type, agent_name)`

Prefer continuity for active jobs unless explicit rerouting is required.

## Health and status cadence

Minimum cadence:

1. At run start: `tenet_get_status()` + `tenet_health_check()`
2. At periodic checkpoints (e.g., every 3 completed jobs): `tenet_health_check()`
3. At run end: `tenet_get_status()`

If health check reports inconsistency, pause dispatch and repair state before continuing.

## Termination conditions

Stop loop only when one is true:

1. **All done**: DAG has no remaining jobs — all completed or explicitly deferred.
2. **All blocked**: remaining jobs are blocked and no independent work exists — report to user.
3. **Emergency halt**: EMERGENCY steer message received.
4. **Safety stop**: safety gates force halt pending user intervention.

On stop:
- Ensure `tenet_get_status()` reflects final state
- All knowledge docs are up to date via `tenet_update_knowledge`
- Report: jobs completed, jobs blocked (with reasons), jobs remaining, lessons learned
