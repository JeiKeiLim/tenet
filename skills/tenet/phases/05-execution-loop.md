# Autonomous Execution Loop

The core of Tenet is the tracked execution loop. You must use the `tenet_*` MCP tools for all job operations. Direct subagent calls or manual code writing during this phase bypasses job tracking, evaluation, and steering.

## Prerequisite

Before entering the execution loop, you MUST have called `tenet_register_jobs` during the decomposition phase. This loads the DAG into the runtime queue. Without registration, `tenet_continue()` will return no jobs.

## Non-Blocking Execution (CRITICAL)

`tenet_job_wait` returns **instantly** with the current job state — it does NOT block or poll. The orchestrator is responsible for scheduling periodic checks via background tasks with a delay between calls (10-15 seconds).

**Never** call `tenet_job_wait` in a tight foreground loop. Each call should be a separate background task. Between checks, the orchestrator remains responsive to user interaction.

## Mandatory Tool Sequence

Execute this sequence for every job cycle:

1.  **Check Steering**: `tenet_process_steer()`
    Ensure no emergency overrides or new directives exist before starting.
2.  **Get Next Job**: `tenet_continue()`
    Retrieves the next pending job from the runtime queue. The response includes `next_job` with its runtime `id`.
3.  **Compile Context**: `tenet_compile_context(job_id="<next_job.id>")`
    Gathers specifications, harness, decomposition, and relevant knowledge into a single string.
4.  **Start Job**: `tenet_start_job(job_id="<next_job.id>")`
    Dispatches the registered job for execution. The MCP server transitions it from pending to running and allocates an agent.
5.  **Brief User**: Tell the user which job was dispatched and that they can interact while it runs.
6.  **Background Status Check**: Dispatch `tenet_job_wait(job_id="...")` as a **background task**.
    The tool returns instantly with the current job state. Use exponential backoff between checks: 30s → 45s → 67s → 100s → 120s (cap).
    When the background task completes:
    - If `is_terminal` is false: check steer, report progress to user, wait (backoff), dispatch another check with the returned `cursor`.
    - If `is_terminal` is true: proceed to step 7.
7.  **Get Result**: `tenet_job_result(job_id="...")`
    Retrieve the final output and execution metadata.
8.  **Start Evaluation**: `tenet_start_eval(job_id="<original_job_id>", output={...})`
    Dispatches the output to the evaluation pipeline.
9.  **Background Wait for Eval**: Same pattern as step 6 — background task with periodic instant checks.
10. **Get Eval Result**: `tenet_job_result(job_id="<eval_job_id>")`
    Check if the job passed requirements.
11. **Update Knowledge**: `tenet_update_knowledge(job_id="...", findings={...})`
    Persist any architectural discoveries or critical findings.
12. **Sync Status Files**:
    Update `.tenet/status/job-queue.md` (mark completed) and `.tenet/status/status.md` (increment counts).
13. **Loop**: Return to Step 1.

## Operational Rules

### Use MCP Tools, Not Subagents
Dispatch work via `tenet_start_job`. Do not call subagents directly. Do not write implementation code yourself during the execution loop. If `tenet_start_job` returns a failure about missing adapters, tell the user to configure the agent via `tenet config --agent <name>`.

### Background Status Check Pattern
`tenet_job_wait` returns **instantly** — it does not block or poll. The orchestrator dispatches it as a background task and waits between checks using exponential backoff: start at 30 seconds, multiply by 1.5× each cycle, cap at 120 seconds. Between checks:
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
- Update `.tenet/status/job-queue.md` to reflect the new state.
- Update `.tenet/status/status.md` with current progress and active job ID.
- Write a journal entry via `tenet_update_knowledge(type="journal")` to log job completion.
- If the job produced reusable technical insight, also write a knowledge entry via `tenet_update_knowledge(type="knowledge")` with appropriate confidence tag.

## Report-Only Jobs (remediation escape hatch)

Some jobs are **report-only** — their deliverable is an assessment or final acceptance report, not code. They must NOT edit project files (other than writing the report itself).

### Marking a job report-only

When registering jobs via `tenet_register_jobs`, include `report_only: true` in the job's params:

```json
{ "id": "e2e-final", "name": "Final acceptance sweep", "report_only": true, "prompt": "..." }
```

Typical cases: final acceptance sweeps, architectural reviews, test-flakiness audits, post-integration drift checks.

### What happens automatically

When a report-only job's context is compiled, `tenet_compile_context` prepends a **Report-Only Scope** preamble telling the worker:

- You MUST NOT edit project files.
- If you find a real bug that must be fixed for the report to be trustworthy, call `tenet_request_remediation({ job_id, reason, suggested_fix, target_files })` instead of editing.

### Remediation flow

1. Report-only agent discovers a real bug during verification.
2. Agent calls `tenet_request_remediation(job_id=<self>, reason=..., suggested_fix=..., target_files=[...])`.
3. Tenet marks the agent's job as `blocked_remediation_required` and spawns a child `dev` job with the requested fix.
4. Agent ends its turn.
5. Orchestrator processes the child like any other dev job: dispatch → eval via `tenet_start_eval` → if all three critics pass, Tenet **auto-resumes** the report-only parent (flips it from `blocked_remediation_required` → `pending`).
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
        tenet_retry_job(job_id=source_job.id)    # fix the source job
    elif finding.category == "test_bug":
        create_test_fix_job(source_job, finding.detail)
    elif finding.category == "harness_bug":
        create_harness_fix_job(finding.detail)   # dev job scoped to build/CI/scripts
    elif finding.category == "evidence_mismatch":
        create_evidence_refresh_job(source_job)  # re-run verification, update report
    elif finding.category == "contention":
        # If we're in parallel mode for this feature, switch to sequential:
        tenet_add_steer(content=f"set eval_parallel_safe=false for {feature}", class="directive")
        tenet_retry_job(job_id=source_job.id)
    elif finding.category == "scope_conflict":
        # Likely a report-only job edited files. The remediation escape hatch
        # handles this — see the report-only section above. If the source wasn't
        # marked report_only, the finding is accurate: mark it report_only going forward
        # and retry with the preamble.
        ...
```

Plain "just retry" wastes cycles on test/harness/evidence bugs — route by category.

## Eval-mode decision (reminder)

The three critics dispatched by `tenet_start_eval` run **in parallel** or **sequentially** based on the readiness gate's `eval_parallel_safe:{feature}` verdict (see `phases/02-spec-and-harness.md`). If the verdict is missing, Tenet defaults to sequential (safe fallback). The orchestrator doesn't need a separate step — just call `tenet_start_eval` and wait for all three job IDs it returns.

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
After each job passes evaluation:
1. Stage all files changed by the job (use `git add` with specific paths from the job's deliverables, avoid `git add -A`)
2. Commit with message: `tenet({job-name}): {short description of what was done}`
3. Do NOT push automatically — the user decides when to push

### On Completion
After all jobs are done:
1. Commit any remaining tenet status/knowledge files: `tenet: finalize {feature}`
2. Tell the user the branch name and suggest: "Run `git push -u origin tenet/{date}-{feature}` when ready"

### Conflict Handling
If a commit fails due to conflicts (e.g., parallel jobs touched the same file):
1. Do NOT force-resolve — report the conflict to the user
2. Create a steer message with the conflict details
3. The user can resolve manually or provide guidance via steer
