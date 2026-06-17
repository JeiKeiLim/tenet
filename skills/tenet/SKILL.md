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
  - tenet_validate_readiness
  - tenet_update_knowledge
  - tenet_add_steer
  - tenet_process_steer
  - tenet_health_check
  - tenet_get_status
  - tenet_retry_job
  - tenet_report_blocking_finding
  # tenet_set_agent is CLI-only, not exposed via MCP
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
  # Playwright MCP tools (used during Stage 5 e2e eval, may not be available)
  - browser_navigate
  - browser_take_screenshot
  - browser_click
  - browser_type
  - browser_fill_form
  - browser_snapshot
  - browser_evaluate
---

# Tenet Skill

Execute Tenet as a checkpoint-driven autonomous development loop. This file is the router and invariant layer. Phase files contain the detailed procedures.

## Index Contract

This `SKILL.md` is an index, not the full procedure. Before doing work for any phase, you MUST:

1. Read the exact phase file named in the Phase Map.
2. Follow that file's procedure, paths, formats, and gates.
3. Keep the phase file open as the source of truth while executing the phase.

Do not execute a phase from memory or from this file's summary. Do not write phase artifacts until the corresponding phase file has been read in the current session. If the phase file cannot be read, stop and report which file is missing.

## Authority Order

When instructions conflict, prefer them in this order:

1. MCP tool schema and tool return values.
2. The phase file for the phase being executed.
3. This top-level skill file.

Do not invent tool calls or runtime state. If a named Tenet MCP tool is missing, stop and report the MCP configuration problem.

## Core Invariants

1. Every implementation job runs through Tenet MCP: `tenet_continue` -> `tenet_compile_context` -> `tenet_start_job` -> `tenet_job_wait` -> `tenet_job_result`.
2. Context is compiled per job with `tenet_compile_context`; do not substitute raw file dumps.
3. Generation and validation are separate contexts.
4. Eval is a hard blocking gate. A failed eval must be retried, remediated, or blocked before dependent work proceeds.
5. Harness enforcement applies in all modes.
6. Human-readable project memory lives under `.tenet/`; live runtime state lives in MCP SQLite under `.tenet/.state/`.
7. Status files are generated from MCP state. Do not manually edit `.tenet/status/status.md` or `.tenet/status/job-queue.md` to advance runtime.
8. Use server-side continuation; do not reconstruct job IDs or dependency state manually.
9. Wrong turns and failed attempts must remain visible to the active retry context.
10. Purpose alignment outranks narrow checkbox compliance.
11. Knowledge writes need confidence tags.
12. Never assume yolo mode. It only activates when the user explicitly says "yolo", "skip questions", "decide everything", "don't ask me questions", or equivalent.
13. Never commit live `.tenet/.state/tenet.db`, `.tenet/.state/tenet.db-wal`, or `.tenet/.state/tenet.db-shm`. If portable Tenet state should be tracked, run `tenet db snapshot` and commit `.tenet/state-snapshot/tenet.db` instead.
14. Durable project doctrine lives in `.tenet/project/**`; normal implementation jobs must not edit it.
15. New feature/run artifacts live under `.tenet/runs/<run-slug>/`. Legacy top-level artifact directories are compatibility lanes only.

## Boot Sequence

Run this before mode selection or execution:

1. Call `tenet_continue()`.
2. If no active Tenet state exists, call `tenet_init(project_path=".")`.
3. Call `tenet_health_check()`.
4. If health fails because the MCP server is unreachable, tell the user: "Tenet MCP server is not running. Run `npx tenet init` in the project root, then restart your agent." Do not self-start the server; host config manages MCP lifecycle.
5. Call `tenet_get_status()`.
6. If either call returns `update_available`, tell the user the current version, latest version, and `update_command`. Do not auto-update during an active run; instruct the user to close the agent, install the update, run `tenet init --upgrade`, then restart.
7. Run the context bootstrap gate before mode selection:
   - Required docs: `.tenet/project/overview.md`, `.tenet/project/architecture.md`, `.tenet/project/product.md`, `.tenet/project/testing.md`, `.tenet/project/design.md`.
   - Pass when all required docs exist and are real (not empty placeholders or obvious templates). Do not judge "thin", "stale", or "needs improvement"; the gate is pass/fail only.
   - If any required doc is a placeholder, classify the project:
     - **Brownfield** (real implementation exists in the repo — non-trivial source outside `.tenet/`, agent config, and scaffolding): the gate fails. Read and execute `phases/00-context-bootstrap.md` to live-scan and synthesize doctrine. Stop normal work until the gate passes.
     - **Greenfield** (no real implementation to scan yet): defer. Do NOT run the bootstrap synthesis and do NOT write status-style "greenfield/TBD" doctrine into `project/`. Leave the placeholders in place — initial project doctrine is authored from the interview output in `phases/01-interview.md` once the interview is done.
8. In the greenfield deferred state, proceed to mode selection and the interview. The bootstrap gate is satisfied post-interview once `phases/01-interview.md` § 11 has written real `project/**` doctrine from interview decisions.
9. Detect whether `.git/` exists. Git behavior is defined in `phases/05-execution-loop.md`.
10. Probe Playwright MCP availability if possible. If unavailable, warn once. This is only non-blocking when the run-local harness/spec marks browser exploration optional, skipped with reason, or not applicable; required browser/visual Layer 2 cannot pass without it.

Do not enter execution while health is bad.

## Mode Selection

Choose one scale-adaptive mode at start and re-evaluate only at major scope changes:

- Full: new feature, greenfield work, unclear edges, major refactor, broad multi-module change.
- Standard: medium complexity, known architecture, moderate unknowns.
- Quick: small isolated bug/config/content tweak with low ambiguity.

Full mode runs crystallization before execution. Standard mode keeps clarification/spec/decomposition compact. Quick mode may register a single-job DAG, but still uses the MCP execution and eval gates.

In Full mode, delivery mode selection is a standalone required checkpoint at the end of the interview:

- `autonomous`: one end-to-end run with no mid-run user checkpoints.
- `agile`: sliced delivery with an initial plan-checkpoint and use-checkpoints after each slice.

Ask a dedicated question that presents both options. Do not bury delivery mode inside a bundled defaults question, and do not infer it from approval of unrelated defaults.

Default to `autonomous` only after the user has seen both options and responds with uncertainty or no preference. Record the prompt, response, selected mode, and selection basis in the interview transcript; copy the selected mode to spec front matter as `delivery_mode`.

## Phase Map

Read the relevant phase file before executing that phase. The phrase "read" means opening the file contents in the current session, not assuming prior knowledge.

1. Context bootstrap: `phases/00-context-bootstrap.md`
2. Interview and clarity gate: `phases/01-interview.md`
3. Pre-spec research, spec, harness, readiness gate: `phases/02-spec-and-harness.md`
4. Visual artifacts and prototypes: `phases/03-visuals.md`
5. DAG decomposition and job registration: `phases/04-decomposition.md`
6. Autonomous execution loop, report-only blocking findings, finding dispatch, and git behavior: `phases/05-execution-loop.md`
7. Evaluation pipeline and failure handling: `phases/06-evaluation.md`
8. Agile checkpoints and redirects: `phases/07-agile-checkpoints.md`

Autonomous Full mode normally follows interview -> visuals -> scenarios -> research/spec/harness/readiness -> decomposition -> execution.

Agile Full mode follows interview -> research/spec/harness -> visuals -> initial plan-checkpoint -> readiness -> per-slice decomposition/execution/use-checkpoint. `phases/07-agile-checkpoints.md` owns checkpoint and redirect behavior.

## Phase Entry Rule

At every phase boundary:

1. Identify the next phase by name.
2. Read its phase file from the Phase Map.
3. Execute only that phase's documented steps.
4. When moving to a new phase, read the new phase file first.

Examples:

- Before asking interview questions, read `phases/01-interview.md`.
- Before writing spec, harness, or scenarios, read `phases/02-spec-and-harness.md`.
- Before generating visuals, read `phases/03-visuals.md`.
- Before registering jobs, read `phases/04-decomposition.md`.
- Before dispatching jobs, read `phases/05-execution-loop.md`.
- Before acting on eval results, read `phases/06-evaluation.md`.
- Before agile plan/use checkpoints or redirects, read `phases/07-agile-checkpoints.md`.

## Gates

- Clarity gate: after interview, call `tenet_validate_clarity()` and wait for the validation job result. Do not self-score.
- Readiness gate: after spec/harness/scenarios and required visuals, call `tenet_validate_readiness` with exact `artifact_paths` and resolve blockers before decomposition.
- Plan/use checkpoints: in agile mode, block until the user responds with `approve`, `redirect: ...`, `cancel`, or `done` as defined in `phases/07-agile-checkpoints.md`.
- Pre-execution gate: before dispatching a DAG or slice DAG, summarize mode, job count, key spec decisions, and harness constraints. Ask for confirmation unless the user explicitly asked to start without oversight.
- Eval gate: after every completed job, call `tenet_start_eval(...)` and wait according to the returned `execution_mode`. All returned eval jobs must pass.

## Execution Rules

Read `phases/05-execution-loop.md` before starting execution.

- Use Tenet MCP tools only. Do not call host subagents directly and do not manually implement job code during the execution loop.
- Dispatch `tenet_job_wait` as background/non-blocking status checks with backoff. Stay responsive to user steering between checks.
- Pass the original job ID to `tenet_start_eval`; pass `feature` when known.
- `tenet_start_eval` may return parallel or sequential eval execution. Wait according to the returned job IDs and `execution_mode`; do not assume all critics are already running.
- Treat all eval failures as blocking for the current job or report-only parent.
- Prefer `tenet_retry_job(job_id, enhanced_prompt)` for failed implementation jobs.
- Use `tenet_report_blocking_finding` only for report-only jobs that discover blocking findings they must not fix directly.
- If a finite retry budget is exhausted, mark/report the job as blocked and continue only to independent jobs. If retries are unlimited, continue only while each retry uses new evidence or a changed approach.
- In agile mode, the normal execution loop is scoped to the current slice; the outer slice/checkpoint loop is defined in `phases/07-agile-checkpoints.md`.

## Steering

When the user sends input during execution:

1. Classify it as `context`, `directive`, or `emergency`.
2. Persist it with `tenet_add_steer(...)`; use `affected_job_ids` when known.
3. Process steering at every loop checkpoint with `tenet_process_steer()`.

User steers outrank agent steers. Emergency steer cancels active jobs via `tenet_cancel_job` and stops dispatch until resolved.

## Knowledge And Journal

Use `tenet_update_knowledge` for both reusable knowledge and session journal entries:

- `type="knowledge"` for facts future jobs or future features can reuse.
- `type="journal"` for job/session history and failure attempts. Journals route to `.tenet/runs/<run-slug>/journal/`.

Use confidence tags such as `[implemented-and-tested]`, `[implemented-not-tested]`, `[decision-only]`, `[scanned-not-verified]`, `[research-verified]`, or `[research-inconclusive]`.

## Safety

- Detect stagnation: repeated identical failures, edit/revert cycles, repeated rereads without new decisions, or repeated tool-call loops.
- Rotate approach before retrying repeatedly. A finite retry budget is a hard stop; unlimited retry mode still stops on stagnation, emergency steer, or user intervention.
- Respect harness danger zones. If breached, cancel active jobs and process emergency steer.
- Do not self-steer to bypass a hard gate.

## Recovery

If Tenet MCP tools stop responding or are unavailable:

1. Do not bypass the pipeline.
2. Run `tenet_health_check()` if available.
3. If MCP is unreachable, tell the user to run `npx tenet init` in the project root and restart the agent.
4. If diagnosis is needed, use the `tenet:diagnose` skill when available.
5. If recovery is not clear, halt and report the error. Do not continue manually.

## Termination

Stop only when one is true:

1. All jobs are complete or explicitly deferred.
2. Remaining jobs are blocked and no independent work exists.
3. Emergency steer is active.
4. Safety gates require user intervention.
5. Agile mode receives `done` or `cancel` at the relevant checkpoint.

On stop, call `tenet_get_status()` and report completed jobs, blocked jobs with reasons, remaining work, and notable lessons.
