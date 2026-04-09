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
