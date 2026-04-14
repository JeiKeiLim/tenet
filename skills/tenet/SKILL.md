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
  - tenet_add_steer
  - tenet_process_steer
  - tenet_health_check
  - tenet_get_status
  # tenet_set_agent is CLI-only — not exposed via MCP
  # Host agent tools (used during crystallization phase)
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  # Research tools (used during interview and pre-spec research)
  - WebSearch
  - WebFetch
  # Playwright MCP tools (used during Stage 5 e2e eval — may not be available)
  - playwright_navigate
  - playwright_screenshot
  - playwright_click
  - playwright_fill
  - playwright_evaluate
  - playwright_get_visible_text
---

# Tenet Skill — Autonomous Development Loop Brain

Execute this file as an operational program. Be decisive, deterministic, and checkpoint-driven.

## Core invariants (never violate)

1. Fresh session per job is default defense against compounding errors.
2. Context is always compiled per job (`tenet_compile_context`), never raw file dumps.
3. Generation and validation are separated (author flow vs critic flow).
4. **Eval is a HARD BLOCKING GATE.** A job that fails eval MUST be retried or blocked. You MUST NOT proceed to the next job saying "the next job will fix it" or "this is not blocking." If eval fails, the job is not done. Period.
5. Harness enforcement is mandatory in **all** modes.
6. Persistent human-readable state lives in `.tenet/` markdown files.
7. Operational runtime state is MCP server SQLite; do not manually manage runtime IDs.
8. Use server-side continuation (`tenet_continue()`), not ad-hoc ID reconstruction.
9. Keep wrong turns in active job context (within that session) to prevent repetition.
10. Purpose alignment outranks narrow spec checkboxing.
11. All knowledge writes are confidence-tagged.
12. **NEVER assume yolo mode.** Yolo mode ONLY activates when the user literally says "yolo", "skip questions", or "decide everything." If uncertain, ask. Default is always interactive.

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

6. **Detect git repository**:
   - Check if `.git/` exists in the project root.
   - If yes, note this for the execution loop — a feature branch will be created before spec generation.
   - If no, skip all git operations.

7. **Check Playwright MCP availability**:
   - Attempt to call a Playwright MCP tool (e.g., `playwright_navigate`). If it responds, Playwright MCP is available.
   - If unavailable, warn the user: "Playwright MCP is not installed. Agent-driven e2e testing (Stage 5) will be skipped. Install @anthropic/playwright-mcp for visual verification."
   - This is a warning, not a blocker — tenet works without Playwright MCP but misses the "human eyes" testing layer.

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
1. Read existing spec/harness for the affected area
2. Register a single job via `tenet_register_jobs` (single-entry DAG)
3. Execute via `tenet_start_job` → `tenet_job_wait` → `tenet_job_result`
4. Run eval via `tenet_start_eval` (code critic + test critic)
5. On eval fail: retry via `tenet_retry_job`

Quick mode skips interview, spec generation, visual artifacts, and decomposition planning.
It does NOT skip the MCP execution pipeline or evaluation gates. All jobs go through
the same `start_job → wait → result → eval` flow regardless of mode.

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
- For UI-facing work, generate 3-5 materially different design mockups.
- Present design mockups to user for approval.
- **After design lock-in**: Build interactive HTML prototypes that simulate core user flows (clickable, realistic data, state transitions). This applies to ALL project types — web, TUI, CLI, API.
- Present prototypes to user — they must click through and confirm behavior before proceeding to spec.

### C) Scenario + anti-scenario criteria

- Define concrete success scenarios.
- Define explicit anti-scenarios (failure shapes to avoid).
- Write to `.tenet/spec/scenarios-{date}-{feature}.md`.
- These become evaluation inputs.

### D) Pre-spec research (mandatory)

**Read `phases/02-spec-and-harness.md` Section 0 before executing.**

- Research every technology, API, and service that will be used.
- Save each research result to knowledge: `tenet_update_knowledge(type="knowledge", title="research-{topic}")`.
- This prevents spec'ing features that are infeasible or choosing suboptimal approaches.
- Do NOT skip even for "simple" projects — real-world complexity always surfaces during implementation.

### E) Spec + Harness generation

**Read `phases/02-spec-and-harness.md` before executing.**

- Write spec to `.tenet/spec/{date}-{feature}.md` (NOT `.tenet/spec.md` or `.tenet/spec/spec.md`).
- Update harness at `.tenet/harness/current.md` (NOT `.tenet/harness.md`).
- Write scenarios to `.tenet/spec/scenarios-{date}-{feature}.md`.
- Lock harness invariants after agreement.

### F) DAG decomposition

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
2. Read existing spec and harness for the affected area.
3. Register a single-job DAG via `tenet_register_jobs`.
4. Proceed to the core autonomous loop (same as full/standard mode).

Quick mode is "quick" because it skips interview/spec/decomposition overhead, NOT because it bypasses the execution pipeline. The job MUST still go through `tenet_start_job`, `tenet_start_eval`, and all eval gates.

## YOLO mode (upfront phases only)

YOLO mode applies to the **crystallization phase** (interview → spec → visuals → decomposition), NOT to execution. When enabled, the agent makes all upfront decisions without asking the user questions — it decides feature scope, acceptance criteria, tech choices, and test strategy autonomously.

YOLO mode is triggered when the user says "yolo", "just decide everything", or "don't ask me questions" during or before the interview phase.

**What YOLO mode skips:** Interview questions, spec confirmation, visual approval, decomposition review.
**What YOLO mode does NOT skip:** Pre-execution confirmation, evaluation gates, steer message processing. These always run.

## Pre-execution confirmation gate

Before entering the autonomous execution loop, present the user with a summary for confirmation:

1. Display: mode, total jobs from DAG, key spec decisions, harness constraints.
2. Ask: "Ready to start autonomous execution? This will dispatch {N} jobs. [Confirm / Adjust]"
3. If user confirms → proceed to execution loop.
4. If user adjusts → apply changes, update docs, re-confirm.

Skip this gate ONLY if the user has explicitly said "just do it" / "start building" without wanting oversight.

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

    # 8. Dispatch evaluation (code critic + test critic + Playwright eval)
    eval = tenet_start_eval(job_id=job.id, output=output)
    # This dispatches THREE jobs: code_critic, test_critic, playwright_eval
    code_check = BACKGROUND tenet_job_wait(job_id=eval.code_critic_job_id)
    test_check = BACKGROUND tenet_job_wait(job_id=eval.test_critic_job_id)
    playwright_check = BACKGROUND tenet_job_wait(job_id=eval.playwright_eval_job_id)

    # Wait for all three eval jobs
    eval_delay = 30
    WHILE any of (code_check, test_check, playwright_check) not terminal:
        SLEEP eval_delay seconds
        eval_delay = min(eval_delay * 1.5, 120)
        IF code_check not terminal:
            code_check = BACKGROUND tenet_job_wait(job_id=eval.code_critic_job_id)
        IF test_check not terminal:
            test_check = BACKGROUND tenet_job_wait(job_id=eval.test_critic_job_id)
        IF playwright_check not terminal:
            playwright_check = BACKGROUND tenet_job_wait(job_id=eval.playwright_eval_job_id)

    code_output = tenet_job_result(job_id=eval.code_critic_job_id)
    test_output = tenet_job_result(job_id=eval.test_critic_job_id)
    playwright_output = tenet_job_result(job_id=eval.playwright_eval_job_id)

    # 9. Act on eval results — ALL THREE must pass
    # ⛔ EVAL IS A HARD BLOCKING GATE — DO NOT PROCEED TO THE NEXT JOB IF EVAL FAILS
    # "The next job will fix it" is NEVER acceptable. Retry THIS job until it passes.
    IF code_output.passed AND test_output.passed AND playwright_output.passed:
        tenet_update_knowledge(type="journal", job_id=job.id, findings=output.findings)
    ELIF NOT playwright_output.passed:
        # Playwright e2e failed — actual app behavior is broken
        # Create fix job with the screenshots and findings as evidence
        create_fix_job(job, playwright_output.exploratory_findings)
        # DO NOT continue to next job — wait for fix job to complete, then re-eval
    ELIF NOT test_output.passed:
        # Test critic failed — tests are insufficient, create fix job to strengthen tests
        create_test_fix_job(job, test_output.missing_tests)
        # DO NOT continue to next job — wait for fix job to complete, then re-eval
    ELSE:
        # Code critic failed — retry the job (preferred) or create new job if approach is wrong
        tenet_retry_job(job_id=job.id)  # preferred over creating new job
        # DO NOT continue to next job — wait for retry to complete, then re-eval

    # 11. Post-job steering checkpoint
    tenet_process_steer()

    # 12. Periodic health audit (every 3 completed jobs)
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

## Evaluation pipeline (6 stages)

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

### Stage 3 — Code critic (independent context)

- Separate context from author reasoning.
- Inputs: job scope + spec/scenarios/anti-scenarios/harness + diff (NO author reasoning).
- Check: does implementation match spec intent FOR THIS JOB'S SCOPE? Anti-scenarios violated? Gaps?
- Apply zero-findings rule: if zero findings, force re-analysis from alternate attack angle.
- Structured self-questioning: edge cases, error paths, integration, security, performance.

### Stage 4 — Test critic (independent context)

- Separate context — reviews TESTS, not implementation code.
- Inputs: job scope + spec/scenarios + acceptance/integration test files.
- Check: are tests sufficient to prove features IN THIS JOB'S SCOPE actually work?
- Verify tests assert **correct outcomes**, not just absence of errors.
- Identify missing test coverage: untested routes, pages, interactive elements WITHIN SCOPE.
- If insufficient: output specific tests to add/strengthen → becomes fix job requirements.

### Stage 5 — Playwright E2E (independent context, two layers)

- Dispatched as a separate `playwright_eval` job alongside code critic and test critic.
- Worker has independent context — does not see implementation code or author reasoning.
- **Layer 1 (Scripted)**: Runs the project's existing Playwright test suite (`npx playwright test`).
- **Layer 2 (Exploratory)**: Worker uses Playwright MCP to navigate the app like a human, click every button, fill every form, take screenshots at each step, and analyze visually.
- Catches: pages not wired to nav, broken CSS, forms that submit but don't redirect, features in spec with no UI path.
- If Playwright MCP is unavailable, Layer 2 is skipped and the eval passes with Layer 1 results only.
- **This is the "human eyes" layer that catches "tests pass, app broken" issues.**

## Knowledge vs Journal

`tenet_update_knowledge` supports two entry types stored in separate directories:

### Knowledge (`.tenet/knowledge/`)
Reusable technical wisdom that helps future agents working on similar features. Examples:
- "Bubbletea TUI height measurement requires terminal resize listener — getTerminalSize() alone is insufficient"
- "Next.js middleware runs on Edge runtime — cannot use Node.js fs module"
- "PostgreSQL NOTIFY has 8KB payload limit — use channel + ID pattern for large payloads"

Use `type: "knowledge"` and tag with confidence:

| Tag | Meaning |
|-----|---------|
| `[implemented-and-tested]` | Code exists and passes tests |
| `[implemented-not-tested]` | Code exists but tests are missing or incomplete |
| `[decision-only]` | Agreed approach, not yet coded |
| `[scanned-not-verified]` | Extracted from existing code during brownfield scan, not validated |

### Journal (`.tenet/journal/`)
Activity logs, job completion summaries, and session progress notes. Written after every job completion to track what happened. Use `type: "journal"` (default).

**Rule of thumb**: If a future agent working on a different feature would benefit from this information, it's knowledge. If it's only useful for tracking what happened in this session, it's journal.

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

**EVAL FAILURE = HARD BLOCK.** Do NOT move to the next job. Do NOT say "this will be addressed later." The current job must pass eval before the DAG advances.

On eval fail:

1. Write a failure journal entry: `tenet_update_knowledge(type="journal", title="failure-{job_name}-trial-{N}")` with details of what was tried and why it failed.
2. Root cause analysis (why this failed, not just what failed)
3. At least two alternative approaches
4. Read any previous failure journals for this job to avoid repeating the same approach
5. Recommended next approach based on what hasn't been tried

**Prefer `tenet_retry_job` over creating a new job.** Retry preserves job lineage and retry count tracking. Only create a new job when the approach is fundamentally wrong and a different scope/strategy is needed.

**On max retries exhausted (3 failures):**
1. Mark job as blocked
2. Write a comprehensive failure journal summarizing ALL attempts
3. Continue to the next **independent** job (one that doesn't depend on this blocked job)
4. Do NOT self-steer to unblock — report to the user

**On eventual success after failures:** Gather all failure journals for this job, extract the lesson learned, and write it to knowledge (not journal) via `tenet_update_knowledge(type="knowledge")`.

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

### Creating steer messages
When the user sends a message during autonomous execution, the orchestrator must:
1. Classify it: `context` (informational), `directive` (priority/scope change), `emergency` (halt)
2. Call `tenet_add_steer(content, class, affected_job_ids)` to persist it in the runtime queue
3. If the orchestrator knows which jobs need this message, set `affected_job_ids` — otherwise leave empty for broadcast

**Do NOT write steer messages to markdown files.** Use `tenet_add_steer` exclusively — this ensures proper lifecycle tracking and job targeting.

### Processing steer messages
Process steer at every checkpoint via `tenet_process_steer()`.

Message classes:

- `context`: informational — no action required, absorbed as context
- `directive`: priority/order/scope changes — act on it
- `emergency`: immediate halt and containment

### Lifecycle tracking

`received → acknowledged → acted_on → resolved`

Never leave messages silently unacknowledged. Call `tenet_process_steer()` at every loop iteration to pick up new messages.

### Source priority
Every steer message has a `source` field: `user` or `agent`.
- **User steers always take priority** over agent steers. If a user steer contradicts an agent steer, follow the user.
- When creating steer messages from user input, set `source: "user"`.
- When self-steering (e.g., unblocking after max retries), set `source: "agent"`.

### Job-targeted steer
When a steer message targets specific jobs (via `affected_job_ids`), only those jobs see it in their compiled context. Broadcast messages (empty `affected_job_ids`) are visible to all jobs.

## MCP server recovery

If tenet MCP tools stop responding (connection errors, timeouts, tool not found):

1. **Do NOT bypass the pipeline.** Never implement features directly without `tenet_start_job` / `tenet_complete_job`.
2. Try restarting the server: run `tenet serve --project .` via Bash, then retry the MCP tool call.
3. If the server won't start, run `tenet diagnose` (or invoke the `tenet:diagnose` skill) to identify the issue.
4. If recovery fails after 2 attempts, **halt and report to user** with the error details. Do not silently continue without MCP.

The MCP pipeline is the source of truth for job orchestration. Working outside it creates desync between git state and job state that is difficult to recover from.

## Safety and resilience gates

Always enforce:

1. **Staleness detector**: repeated no-improvement cycles trigger persona rotation, then halt.
2. **Max consecutive failures**: cap retries per job (configurable via `tenet config --max-retries <n>`, default 3), then mark blocked, move to next independent job.
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

Agent switching is managed via the CLI (`tenet config set default_agent <name>`), not via MCP tools.
This prevents agents from switching their own runtime mid-execution (e.g., Codex switching to OpenCode due to capacity limits).

Prefer continuity for active jobs unless explicit rerouting is required by the user.

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
