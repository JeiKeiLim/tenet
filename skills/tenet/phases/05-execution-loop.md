# Autonomous Execution Loop

The core of Tenet is the tracked execution loop. You must use the `tenet_*` MCP tools for all job operations. All job work — run inline or delegated to a host sub-agent — must flow through tenet MCP tools. Untracked work (manual code writing, direct file edits, or a sub-agent that bypasses tenet tools) breaks job tracking, evaluation, and steering.

## Prerequisite

Before entering the execution loop, you MUST have called `tenet_register_jobs` during the decomposition phase. This loads the DAG into the runtime queue. Without registration, `tenet_continue()` will return no jobs.

The pre-execution confirmation gate in `phases/04-decomposition.md` MUST also be satisfied before this phase starts. If the user has not confirmed after seeing the registered job summary, return to that gate before calling `tenet_continue()` or `tenet_start_job`.

## Non-Blocking Execution (CRITICAL)

`tenet_job_wait` returns instantly when `wait_seconds` is omitted or `0`. It can also long-poll for up to 120 seconds when `wait_seconds` is provided. The recommended orchestration pattern is periodic background checks with exponential backoff: 30s -> 45s -> 67s -> 100s -> 120s cap.

**Never** call `tenet_job_wait` in a tight foreground loop. Use a bounded `wait_seconds` or schedule each check as a separate background task. Between checks, the orchestrator remains responsive to user interaction.

## Mandatory Tool Sequence

Execute this sequence for every job cycle:

1.  **Check Steering**: `tenet_process_steer()`
    Read `user_messages` first (always returned in full — human input can never be crowded out by agent noise), then `agent_messages`. Ensure no emergency overrides or new directives exist before starting. `truncated: true` means there are more agent steers than shown — widen `limit` or run a sweep to drain them. Retire steers you have handled this cycle with `tenet_update_steer` (see **Steer Hygiene** below).
2.  **Get Next Job**: `tenet_continue()`
    Retrieves the next pending job from the runtime queue. The response includes `next_job` with its runtime `id`.
3.  **Compile Context**: `tenet_compile_context(job_id="<next_job.id>")`
    Gathers project doctrine, run-local specifications, harness, decomposition, and relevant knowledge listings into a single string. For current runs, this reads the exact `artifact_paths`, `run_slug`, and `run_path` stored on the job during `tenet_register_jobs`; feature-only filename lookup is a compatibility fallback.
4.  **Start Job**: `tenet_start_job(job_id="<next_job.id>")`
    Dispatches the registered job for execution. The MCP server transitions it from pending to running and allocates an agent.
5.  **Brief User**: Tell the user which job was dispatched and that they can interact while it runs.
6.  **Background Status Check**: Dispatch `tenet_job_wait(job_id="...")` as a **background task**.
    Omit `wait_seconds` for an instant status check, or set a bounded `wait_seconds` for long-polling. Use exponential backoff between checks: 30s → 45s → 67s → 100s → 120s (cap).
    **Delegate this span (steps 6–10: wait → eval → wait → gather) to a single tracked sub-agent** (see **Tracked Sub-Agent Delegation** under Operational Rules) instead of running it inline — it is mechanical and pollutes your context, especially on long runs. Run it inline only for short runs, or if your host can't grant a sub-agent tenet MCP access.
    When the background task completes:
    - If `is_terminal` is false: check steer, report progress to user, wait (backoff), dispatch another check with the returned `cursor`.
    - If `is_terminal` is true: proceed to step 7.
7.  **Get Result**: `tenet_job_result(job_id="...")`
    Retrieve the final output and execution metadata. If the project is a git repository, read the worker's final output for the commit SHA. If the worker produced dirty changes but did not commit, make a best-effort fallback commit for the same job before evaluation. If git is unavailable or the fallback commit fails, write a journal note with the reason and continue.
    **Context-limit / error exit (worker):** if the worker's result has no real deliverable — a context-limit or error string (e.g. "prompt is too long", "maximum context length exceeded"), an empty/truncated body, or a hard failure — do NOT proceed to evaluation as if it succeeded. Treat it as a failed run: retry as-is with `tenet_retry_job` so it re-runs with fresh context (apply backoff between attempts). If the same worker context-limits **twice in a row**, the job is too large for one pass — split it into smaller sub-jobs rather than retrying identical a third time. Never accept a context-limited worker result as a done deliverable.
8.  **Start Evaluation**: `tenet_start_eval(job_id="<original_job_id>", output={...}, feature="<feature>")`
    Dispatches the output to the evaluation pipeline and returns eval job IDs plus `execution_mode`.
9.  **Background Wait for Eval**: Same pattern as step 6. If `execution_mode` is sequential, later eval jobs may remain pending until parents complete; keep waiting on the returned IDs until all are terminal.
10. **Get Eval Results**: `tenet_job_result(job_id="<eval_job_id>")`
    Retrieve every returned eval result. ALL must pass. A critic/eval result passes **only** when it returns a valid rubric JSON with `passed: true`. A result with **no valid rubric JSON — a context-limit / error exit** (e.g. "prompt is too long", "maximum context length exceeded", a raw error string, or an empty/truncated body) — **is NOT a pass**, even though the job reached a terminal state. Do not treat a context-limited critic as "passed with partial result"; the resume gate already refuses to unblock on unparseable output, and you must do the same.

    **On a context-limit / no-rubric critic exit:**
    - **Retry as-is first.** `tenet_retry_job(job_id)` the affected critic so it re-runs with fresh context. This counts against the job's normal retry budget (default unlimited); apply backoff between attempts.
    - **Split after 2 consecutive context-limits.** If the same critic context-limits twice in a row, the scope is too large for one pass — do not retry identical a third time. Split the critic's scope into multiple reduced-scope critic jobs (divide the files/diff into smaller batches, each its own eval job) and require all of those to pass. For a worker, redispatch as smaller sub-jobs.
    - **Never accept a context-limited result as a pass** to move on. If retries and splits keep failing, treat it as a failed eval: `tenet_retry_job` the source, or `tenet_report_blocking_finding` if a specific cause is suspected.
11. **Update Knowledge or Retry**: `tenet_update_knowledge(...)` on success; `tenet_retry_job(...)` or `tenet_report_blocking_finding(...)` on failure, as described below.
    Persist any architectural discoveries or critical findings.
12. **Trust Status Sync**:
    `.tenet/status/job-queue.md` and `.tenet/status/status.md` are generated from MCP state transitions. Do not edit them manually to advance runtime.
13. **Loop**: Return to Step 1.

## Run Completion — Doctrine Drift Review

Steps 1–13 are the **per-job** cycle. The loop exits when `tenet_continue()` returns `all_done: true` (no `next_job`, nothing running), or when agile mode reaches its final checkpoint. At run completion, **before** the final `tenet_get_status()` report, run the doctrine drift review.

`.tenet/project/**` doctrine is read at the start of every run (`tenet_compile_context`) but never re-scanned, so once it drifts, every subsequent run starts on stale context. This step keeps it from silently rotting — and it never blocks the loop.

1. **Collect drift notes.** Drift notes do not always land in the journal, so scan every place a dev job might have written one:
   - **Run journal** (`.tenet/runs/<run-slug>/journal/`): entries titled `doctrine drift: <file>` — the exact contract dev jobs are told to use.
   - **Run docs** (`.tenet/runs/<run-slug>/**`, e.g. `design.md`, `spec.md`): lines carrying the `### doctrine-drift: <file>` marker, **plus** any freeform prose describing doctrine as stale/wrong/missing even without the marker. LLMs do not always use the marker they were given — read for the *intent*, not just the token.
   Match each note to its `doctrine_file`, then **dedupe by `doctrine_file`**: if the same drift surfaces via the journal, a marker, and freeform prose, that is ONE proposal, not three. See *Project Doctrine Write Boundary* below for the note shape.
2. **If there are none, stop.** Doctrine is current — write no proposal, no overhead. Continue to the final report.
3. **Consolidate.** For each affected `.tenet/project/**` file, read the current doctrine and weigh the drift notes against it; draft one consolidated proposal per file (merge related notes, drop contradictions).
4. **Append the proposals** to `.tenet/runs/<run-slug>/doctrine-proposals.md` (create the file if absent). One section per proposal:

   ```markdown
   ## project/<file>.md — <short reason>
   - status: proposed
   - current_claim: ...
   - observed_reality: ...
   - proposed_change: ...
   - rationale: ...
   - source_notes: [drift-note titles from the journal]
   ```

   This file is **append-only** and lives with the run, so it survives compaction and a lost session — proposals are never silently dropped.
5. **Never block.** In autonomous mode, state the count and path in the final report and continue — the user applies proposals between runs. In attended/agile mode you may offer to apply accepted proposals inline (see *Applying a proposal*). Do not stall the run waiting on a decision.

### Applying a proposal

Proposals are applied by a doctrine-maintenance job through the **existing** tools — there is no new tool for this. To apply an accepted proposal:

```
tenet_start_job(job_type="dev", params={
  name: "doctrine maintenance: <file>",
  prompt: "<the proposal's proposed_change, with current_claim + observed_reality as context>",
  allow_project_doctrine_edits: true
})
```

`allow_project_doctrine_edits: true` authorizes the `.tenet/project/**` edit and is eval-safe — the code critic's `scope_conflict` check honors it (see `phases/06-evaluation.md`). After the job passes eval, **re-run the bootstrap gate** (`phases/00-context-bootstrap.md`) to confirm doctrine is coherent, then set the proposal's `status: applied`. Doctrine is re-synthesized and re-gated, not raw-patched — that is what "maintained correctly" means.

## Operational Rules

### Use MCP Tools, Not Untracked Work
Dispatch work via `tenet_start_job`. Do not write implementation code yourself during the execution loop. You MAY delegate a slice of the loop (e.g. the wait→eval→wait→gather span) to a host sub-agent, but only if every operation the sub-agent performs is a tenet MCP tool call (see **Tracked Sub-Agent Delegation** below). A sub-agent that edits files, writes code, or otherwise bypasses tenet tools is forbidden for the same reason manual code writing is. If `tenet_start_job` returns a failure about missing adapters, tell the user to configure the agent via `tenet config --agent <name>`.

### Tracked Sub-Agent Delegation (recommended)

Hand the wait→eval→wait→gather span (steps 6–10) to a single host sub-agent so your main context stays clean — the repeated status checks of a long run otherwise fill it with poll noise. The sub-agent checks the worker's status, dispatches critics via `tenet_start_eval`, waits on every returned job, and returns a per-critic PASS/FAIL summary. You then resume the work only the orchestrator owns: steer check (step 1), brief-user (step 5), git fallback commit + context-limit/split decisions (step 7), `tenet_update_knowledge` (step 11), status sync (step 12), and finding-category routing.

Run the span inline only for short runs, or when your host cannot grant a sub-agent tenet MCP access.

The sub-agent must:

- **Wait with backoff, never one blocking call.** Loop `tenet_job_wait` on the 30s → 45s → 67s → 100s → 120s (cap) schedule, re-calling with the returned `cursor` until `is_terminal`. A single `wait_seconds=120` returns non-terminal after at most 120s and cannot cover a long job.
- **Read the critic count from the tool, never hardcode it.** `tenet_start_eval` returns a variable-length `jobs[]`; loop `tenet_job_wait` across every returned ID until all are terminal. In sequential `execution_mode`, later critics stay pending until their parent completes.
- **Parse the rubric, not a top-level `passed`.** `tenet_job_result` returns `{job_id, status, output, error, duration_ms}` — there is no top-level `passed` field. The critic's verdict is rubric JSON nested in `output.output`; extract it and read `passed` from there.
- **Apply the three-way classifier.** A terminal critic with no valid rubric JSON (context-limit / error / empty body) is **not** a pass — retry as-is, then split after 2 consecutive context-limits. Never accept a context-limited critic as a pass.
- **Process steer within the delegated window.** The sub-agent re-checks `tenet_process_steer()` between waits so an emergency halt or new directive is not missed while you are not driving the loop directly.
- **Return a structured summary** (per-critic PASS/FAIL + failure reasons). The orchestrator resumes from there.

The sub-agent must NOT edit files, write code, or perform any non-tenet operation — if it does, it has left the tracked loop and the run is no longer reliable.

### Project Doctrine Write Boundary
Normal implementation, integration, eval, spec, decomposition, harness, and visual jobs must not edit `.tenet/project/**`. They may read project doctrine and write run-local evidence under `.tenet/runs/<run-slug>/**`.

If a normal job discovers that project doctrine is missing, stale, or wrong, it must record a **doctrine-drift note** — it must NOT edit `.tenet/project/**`. Write the note to the run journal via `tenet_update_knowledge(type="journal", title="doctrine drift: <file>")` with these `findings` fields:

- **doctrine_file** — which `.tenet/project/**` file is affected (e.g. `project/architecture.md`)
- **current_claim** — what the doctrine currently asserts
- **observed_reality** — what the code or run actually shows
- **proposed_change** — the specific edit that would bring doctrine back in line

Also drop a `### doctrine-drift: <file>` marker at the spot in the run doc (e.g. `design.md`) where the drift is noted inline. The run-end review scans both the journal and run docs, and dedupes by `doctrine_file`, so writing the note either way is fine — but the marker guarantees it is found even when the note is written freeform.

Only explicit context-bootstrap, an authorized doctrine-maintenance job (`allow_project_doctrine_edits: true`), or direct user-requested doctrine work may edit `.tenet/project/**`. Drift notes are the input that keeps `.tenet/project/**` from silently rotting — they are collected into durable proposals at run completion (see **Run Completion — Doctrine Drift Review** below).

### Background Status Check Pattern
`tenet_job_wait` returns instantly by default, or long-polls when `wait_seconds` is set. The orchestrator dispatches bounded waits as background tasks and waits between checks using exponential backoff: start at 30 seconds, multiply by 1.5× each cycle, cap at 120 seconds. Between checks:
- The orchestrator is fully responsive to user interaction
- Steer messages are processed on each check cycle
- The user sees progress updates

### User Interaction During Execution
Between background wait notifications, the user can:
- Send messages to the orchestrator
- Add steer directives (DIRECTIVE: prefix)
- Request emergency halt (EMERGENCY: prefix)
- Ask about progress

The orchestrator checks `tenet_process_steer()` on each notification cycle to pick up these messages.

### MCP Unavailability
If `tenet_*` tools are missing, do not fall back to manual execution. Tell the user: "Tenet MCP server not connected. Run `npx tenet init` and restart."

### State Synchronization
After every job:
- Let MCP update `.tenet/status/job-queue.md` and `.tenet/status/status.md` from SQLite state.
- Write a journal entry via `tenet_update_knowledge(type="journal")` to log job completion. Journals write to `.tenet/runs/<run-slug>/journal/`.
- If the job produced reusable technical insight, also write a knowledge entry via `tenet_update_knowledge(type="knowledge")` with appropriate confidence tag.

### Steer Hygiene

The steer inbox must be maintained or it stops being useful — agent self-notes accumulate and crowd out real signal. Every cycle:

- **Read `user_messages` first.** They are always returned in full; agent noise can never hide them.
- **Retire what you've handled.** A `context` steer is one-time — resolve it with `tenet_update_steer(ids=[...], status="resolved")` once consumed, or sweep all agent-context at a run/slice boundary: `tenet_update_steer(sweep="agent_context", status="resolved")`.
- **Retire directives only when clearly done.** Resolve a `directive` once the work it governed is complete or clearly superseded. If you are unsure it still applies, **leave it** — never discard user input on a guess.
- **Keep standing rules.** A directive that must hold across jobs (e.g. "all DB changes need a migration") stays active every cycle until you retire it by id. The sweep never touches directives or user steers, so they are safe.
- **Self-notes are `context`.** Anything you add for yourself (contention notes, self-unblocking) goes in as `class="context"` with the default agent source, so it stays sweepable and won't pile up as `directive`s.

## Report-Only Jobs (blocking finding escape hatch)

Some jobs are **report-only** — their deliverable is an assessment or final acceptance report, not code. They must NOT edit project files (other than writing the report itself).

### Marking a job report-only

When registering jobs via `tenet_register_jobs`, include `report_only: true` in the job's params:

```json
{ "id": "e2e-final", "name": "Final acceptance sweep", "report_only": true, "prompt": "..." }
```

Typical cases: final acceptance sweeps, architectural reviews, test-flakiness audits, post-integration drift checks.

### What happens automatically

When a report-only job is dispatched, the worker dispatch path prepends a **Report-Only Scope** preamble telling the worker:

- You MUST NOT edit project files.
- If you find a blocking finding that must be resolved for the report to be trustworthy, call `tenet_report_blocking_finding({ job_id, finding, why_it_blocks_report, recommended_followup, suspected_files })` instead of editing.

### Blocking finding flow

1. Report-only agent discovers a blocking finding during verification.
2. Agent calls `tenet_report_blocking_finding(job_id=<self>, finding=..., why_it_blocks_report=..., recommended_followup=..., suspected_files=[...])`.
3. Tenet marks the agent's job as `blocked_on_finding` and spawns a linked child `dev` follow-up job.
4. The report-only worker stops report-only work and does not edit files for the finding.
5. Orchestrator processes the child like any other dev job: dispatch → eval via `tenet_start_eval` → if all configured critics pass, Tenet **auto-resumes** the report-only parent (flips it from `blocked_on_finding` → `pending`). The gate tracks the configured critic set, so disabling a built-in or adding a custom critic does not strand a blocked parent.
6. Orchestrator picks up the parent via `tenet_continue()` and redispatches it with fresh context (it now sees the post-fix state).

### Why this shape

- Report-only scope remains inviolate (code critic would otherwise fail the job for editing files out of scope).
- Real bugs still get fixed (not silently worked around or left in the report).
- The orchestrator doesn't need to second-guess scope — the escape hatch is structured.

## Finding-category dispatch

When `tenet_start_eval` returns failing critics, read each finding's `category` and dispatch the correct follow-up:

```
for finding in code_output.findings + test_output.findings:
    if finding.category == "product_bug":
        tenet_retry_job(job_id=source_job.id, enhanced_prompt=finding.detail)
    elif finding.category == "test_bug":
        tenet_retry_job(job_id=source_job.id, enhanced_prompt="Strengthen or correct tests: " + finding.detail)
    elif finding.category == "harness_bug":
        tenet_retry_job(job_id=source_job.id, enhanced_prompt="Fix harness/build/test issue: " + finding.detail)
    elif finding.category == "evidence_mismatch":
        tenet_retry_job(job_id=source_job.id, enhanced_prompt="Refresh evidence from current commands: " + finding.detail)
    elif finding.category == "contention":
        # If we're in parallel mode for this feature, switch to sequential:
        # Agent self-note -> context (sweepable), not directive
        tenet_add_steer(content=f"set eval_parallel_safe=false for {feature}", class="context")
        tenet_retry_job(job_id=source_job.id)
    elif finding.category == "scope_conflict":
        # If this is a report-only job that discovered a blocking finding, use the
        # blocking finding escape hatch. Otherwise retry with corrected scope.
        if source_job.report_only:
            tenet_report_blocking_finding(
                job_id=source_job.id,
                finding=finding.detail,
                why_it_blocks_report="The report-only job cannot produce a trustworthy report until this finding is resolved.",
                recommended_followup="Resolve the scoped issue without report-only edits",
                suspected_files=[]
            )
        else:
            tenet_retry_job(job_id=source_job.id, enhanced_prompt="Respect declared scope: " + finding.detail)
```

Plain "just retry" wastes cycles on test/harness/evidence bugs — route by category and include the category-specific context in the enhanced prompt. Use `tenet_report_blocking_finding` only for report-only jobs that must not edit files directly.

## Eval-mode decision (reminder)

The critics dispatched by `tenet_start_eval` (the configured set from `.tenet/critics.json`) run **in parallel** or **sequentially** based on the readiness gate's `eval_parallel_safe:{feature}` verdict (see `phases/02-spec-and-harness.md`). If the verdict is missing, Tenet defaults to sequential (safe fallback). The orchestrator doesn't need a separate step — just call `tenet_start_eval` and wait for every job id in the `jobs[]` list it returns.

## Git-Aware Pipeline

When the project is a git repository (`.git/` exists), the orchestrator should integrate git operations into the workflow. This is optional — if no git directory exists, skip all git steps.

### Branch Strategy
Create the feature branch BEFORE committing any tenet artifacts. This ensures all spec, interview, and decomposition documents live on the feature branch from the start.

**Timing: immediately after interview begins (before spec generation):**
1. Check if `.git/` exists in the project root
2. If yes, create a feature branch: `tenet/{date}-{feature}` (e.g. `tenet/2026-04-09-oauth`)
3. Switch to the branch BEFORE writing any spec/scenario/decomposition files

**After decomposition is complete (before first job dispatch):**
4. Commit all tenet artifacts (interview, spec, scenarios, decomposition, research, visuals) with message: `tenet: add spec and decomposition for {feature}`

The branch must exist before any commits. Do NOT commit to main/master and then create a branch.

### Per-Job Commits
Per-job commits are a prompt/process policy in this pass. Do not invent a finalization MCP tool, a commit-only `tenet_start_job`, or a new runtime state.

Live SQLite files are not commit artifacts. Never stage or force-add `.tenet/.state/tenet.db`, `.tenet/.state/tenet.db-wal`, or `.tenet/.state/tenet.db-shm`. When the run should preserve portable Tenet state in Git, run `tenet db snapshot` after the relevant state change and stage `.tenet/state-snapshot/tenet.db` instead.

The worker is the primary committer. Before a dev job exits, it should:
1. Stage all files it changed with specific paths, including relevant `.tenet` documents it created or edited. Avoid `git add -A`.
2. Commit with message: `tenet({job-name}): {short description of what was done}`.
3. Include the commit SHA in its final output.
4. Do NOT push automatically — the user decides when to push.

The orchestrator performs only a best-effort process check after `tenet_job_result`:
1. If the worker reported a commit SHA and the tree is clean enough to continue, proceed to evaluation.
2. If useful dirty changes remain because the worker did not commit, make a fallback commit for the same job using the same message style.
3. If git is unavailable, commit identity is missing, or the fallback commit fails, write a journal note with `tenet_update_knowledge(type="journal")` and continue. For jobs with `run_path`, this lands under `.tenet/runs/<run-slug>/journal/`. Do not stop the run for ordinary git hygiene issues.

### On Completion
After all jobs are done:
1. Commit any remaining tenet status/knowledge files: `tenet: finalize {feature}`
2. Tell the user the branch name and suggest: "Run `git push -u origin tenet/{date}-{feature}` when ready"

### Conflict Handling
If a commit fails due to conflicts (e.g., parallel jobs touched the same file):
1. Do NOT force-resolve.
2. Write a journal note with the conflict details and continue the pipeline where possible.
3. Surface the conflict in the next user-facing status summary so the user can resolve manually or provide guidance via steer.
