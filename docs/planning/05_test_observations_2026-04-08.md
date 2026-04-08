# Tenet Test Observations — 2026-04-08

## What's Working

| # | Observation | Assessment |
|---|---|---|
| 1 | Moved `.tenet/` between directories, continued seamlessly | SQLite state is portable — session resumption works |
| 2 | Long-running execution without blocking (for ~1 hour) | Non-blocking `tenet_job_wait` pattern is working |
| 3 | `tenet_start_job` → `tenet_start_eval` → `tenet_update_knowledge` chain working | Core execution pipeline is functional |
| 4 | Knowledge files being recorded | Knowledge persistence works |
| 5 | Multiple jobs being dispatched | DAG execution is progressing |
| 6 | Job is still running after extended time | Long-running autonomy goal is being met |

## Issues to Fix

| # | Observation | Root Cause | Priority |
|---|---|---|---|
| 7 | Question modal stopped appearing, fell back to inline text | SKILL.md doesn't instruct agents to use the host's question/dialog tool. Agent-decided behavior that drifts over long sessions. Need explicit instruction. | Medium |
| 8 | After ~1 hour, started blocking on wait again | Likely caused by context compaction — the agent loses the non-blocking wait instructions when older context gets compacted out. The pseudocode and behavioral instructions get dropped. This is a fundamental challenge for long-running sessions. | Medium |
| 9 | `tenet status` shows 0 completed jobs — not synced with reality | `tenet status` CLI reads SQLite, but the MCP server's `tenet_get_status` and the markdown status files aren't being updated when jobs complete. The job completion happens inside `executeJob()` but doesn't trigger a status file write. | **High** |
| 10 | `.tenet/status/job-queue.md` and `status.md` not being updated | Same root cause as #9. The SKILL.md says "Sync Status Files" (step 12 in loop) but the agent skips it because it's manual markdown writing. Should be automatic via MCP — when a job completes, the server should update these files. | **High** |
| 11 | Knowledge recorded by orchestrator, not worker | The orchestrator calls `tenet_update_knowledge` after getting eval results. This is actually the designed flow (orchestrator manages knowledge). But the knowledge content may be shallow since the orchestrator only sees the output summary, not the worker's full reasoning. | Low — by design |
| 12 | Sequential not parallel job dispatch | Current `tenet_continue` returns ONE next job. Parallel dispatch would need `tenet_continue` to return ALL ready jobs (no unmet dependencies). Noted for later. | Low — noted |
| 13 | Does agent look at knowledge when necessary? | `tenet_compile_context` currently doesn't read `.tenet/knowledge/*.md`. However, blindly concatenating all knowledge would bloat context. Better approach: don't include in compile_context — instead let sub-agents decide which knowledge files to read based on filenames (which are now descriptive dated slugs). The self-explanatory filenames enable this. | Medium — design decision |
| 14 | Run → eval → fail → improve loop — does it work? | Not observed in this test (no eval failures occurred). The SKILL.md defines the flow (eval failure handling + stagnation detection). Needs deliberate testing with a scenario that triggers eval failure. | Low — not yet observed |
| 15 | Mockup feedback "I want it cuter" acknowledged but agent moved on without redrawing | Agent noted the feedback but decided it had enough context to proceed. The visuals phase doc should require the agent to regenerate and present updated mockups when user gives design feedback, and only proceed on explicit user confirmation like "looks good" or "approved". | Medium |
| 16 | Document names don't consider multiple session runs | Current design: `interview.md`, `spec.md` are single files. If user runs Tenet again for a new feature, these get overwritten. Since Tenet is meant for long-term repeated use, documents should be scoped per feature/session. Needs design: feature-branch-style naming? Session-prefixed directories? Append-only with sections? | **High** — design decision |
| 17 | `tenet status` should show live job data from database | The MCP `tenet_get_status` reads SQLite but the CLI `tenet status` shows stale markdown first. Should show real-time DB state prominently. | Medium |
| 18 | Orchestrator stalled after ~2 hours, pipeline stopped | Main orchestrator agent is the loop driver. When it stalls (compaction), workers finish but nobody collects results or dispatches next job. User nudge with `/tenet get status` triggered recovery. See detailed analysis in "Late-Session Observation" section below. | **High** |
| 19 | Worker did exploration instead of implementation (job-10) | Worker agent interpreted job prompt as "research" not "build." Exited 0, MCP marked job completed. But no code was produced — deliverables missing. Compiled context / job prompt wasn't explicit enough about expected output. | **High** |
| 20 | Can't retry a completed job — same job_id rejected | `tenet_start_job(job_id=...)` rejects jobs not in `pending` status. Orchestrator correctly identified missing deliverables but couldn't re-dispatch. Worked around with ad-hoc job, which breaks DAG tracking (ad-hoc isn't linked to original job-10's dependents). Need a `tenet_retry_job` mechanism that resets a completed/failed job back to pending. | **High** |

## Prioritized Action Items

### High priority
1. Auto-update `.tenet/status/job-queue.md` and `status.md` when jobs complete (server-side, not agent responsibility)
2. Fix `tenet status` CLI to show real-time DB state as primary output
3. Design multi-session document structure — Tenet is for long-term repeated use, not one-shot
4. Solve orchestrator stall problem (#18) — move orchestration loop into MCP server so it doesn't depend on the main agent staying alive
5. Add `tenet_retry_job` tool — reset a completed/failed job back to pending for re-dispatch, preserving DAG linkage (#20)
6. Improve job prompt quality / compiled context — worker agents must understand they need to produce code, not just explore. "dev" job type should have explicit deliverable expectations in the prompt (#19)

### Medium priority
4. Add SKILL.md instruction to prefer question dialog/modal when asking user questions
5. Visuals phase: require mockup regeneration on user design feedback, explicit confirmation required before proceeding
6. Knowledge access strategy: keep filenames descriptive so sub-agents can selectively read relevant knowledge files rather than bloating compile_context with everything
7. Investigate compaction-induced drift (blocking wait after ~1 hour) — may need key instructions repeated in a compaction-safe location

### Low priority / future
8. Parallel job dispatch (return all ready jobs from `tenet_continue`)
9. Deliberately test eval failure → retry loop
10. Knowledge depth — should workers also write knowledge, not just orchestrator?

## User Clarifications (from review)
- **#8**: Blocking after 1 hour likely caused by compaction dropping the non-blocking instructions, not OpenCode's limit
- **#13**: Concatenating all knowledge would bloat context. Better to let sub-agents selectively read by filename.
- **#14**: Haven't actually seen this fail — was asking if it works. Needs deliberate testing.
- **#15**: Agent didn't ignore feedback — it acknowledged "cuter" but didn't redraw. User wanted to SEE the updated mockup before proceeding.
- **#16**: This is important for long-term use. Assume user will run Tenet every time they want to do something. Documents must not overwrite previous sessions' work.

## Late-Session Observation (~2 hours in)

### #18: Orchestrator stalled — pipeline stopped until user nudged it

**What happened:** After ~2 hours, the main orchestrator agent stopped polling job status. Worker jobs finished in the background but nothing collected results or dispatched the next job. User sent `/tenet get status` which triggered the orchestrator to run the boot sequence, discover completed jobs, and resume the pipeline.

**Agent log:**
```
Running Tenet boot sequence to get current status.
⚙ tenet_tenet_get_status
⚙ tenet_tenet_health_check
⚙ tenet_tenet_process_steer
⚙ tenet_tenet_continue
⚙ tenet_tenet_job_wait [job_id=dbeb2926-...]
Job-9 (Progression Service) completed. Let me get the result:
⚙ tenet_tenet_job_result [job_id=dbeb2926-...]
```

**Root cause — architecture clarification:**

The current architecture has three layers:
1. **MCP server** = dumb engine. Stores state in SQLite. Spawns worker subprocesses. Does NOT drive the loop.
2. **Main orchestrator agent** = the brain. The OpenCode session the user interacts with. Runs the dispatch → wait → collect → eval → next cycle. **This is the bottleneck.**
3. **Worker agents** = spawned `opencode run` subprocesses. Execute independently. Write code. Finish and exit.

The orchestrator drives everything: dispatching jobs, polling status, collecting results, running eval, updating knowledge, advancing to the next job. When the orchestrator stalls (compaction, drift, user inactivity), the pipeline stops — even though workers may finish fine and the MCP server has their results sitting in SQLite.

**This means "12+ hour autonomous operation" requires the orchestrator to stay alive and active for 12+ hours.** If context compaction drops the loop instructions, it stalls.

**Possible solutions (not yet implemented):**
- **Server-side loop driver** ← USER DECISION: This is the direction. Move the orchestration loop INTO the MCP server. The server itself drives `continue → start_job → poll → eval → next`. The orchestrator agent becomes a supervisor that just watches and handles user interaction. This is a major architecture change that requires detailed design discussion.
- **Heartbeat/watchdog**: The MCP server monitors orchestrator activity. If no `tenet_job_wait` call for N minutes, it sends a notification/steer message to wake the orchestrator. Lighter change.
- **Self-healing boot**: On any user interaction, always run a quick `tenet_continue()` check to catch up on completed jobs. This is what accidentally happened here and it worked. Could be formalized.
- **Compaction-safe instructions**: Put the critical loop behavior (non-blocking wait, periodic check) in a location that survives compaction — e.g., the MCP tool descriptions themselves, or a short repeated "reminder" section at the end of SKILL.md.

**Priority: High** — this is the core reliability problem for long-running autonomy.

## Server-Side Loop Driver — Design Discussion Points

Moving the orchestration loop into the MCP server is the right direction but raises fundamental questions that need resolution before implementation:

### The "loop without a brain" problem
The MCP server is currently a dumb state machine. Making it drive the loop means it needs decision-making:
- When a job completes, what's "good enough" output vs "worker just explored"?
- How does the server decide to retry vs advance?
- The eval pipeline itself dispatches an agent — who interprets the eval result?

### What moves into the server
- Job lifecycle: `job completes → auto-run eval → interpret result → advance DAG or retry`
- Status file sync: auto-update markdown files on state transitions
- Retry logic: reset failed/incomplete jobs, re-dispatch with enhanced prompt
- Parallel dispatch: start all independent jobs simultaneously

### What stays with the orchestrator agent
- Crystallization phase (interview, spec, visuals, decomposition) — requires user interaction
- Steer message processing — requires understanding natural language
- Knowledge interpretation — requires judgment
- User communication — progress updates, confirmations

### Open questions for discussion
1. **Eval interpretation**: The server spawns an eval agent, but who reads the result? If the server auto-advances on `passed=true`, what about nuanced eval outputs like "passed but with concerns"?
2. **Deliverable validation**: Job-10 "completed" but produced no code. The server needs a mechanical check — did the job produce files? Did tests change? This is Stage 1 (mechanical) eval, which could be server-side.
3. **Prompt enhancement on retry**: When a job fails or produces no deliverables, the retry needs a better prompt. Who writes it? The server can append "Previous attempt failed: {reason}. You MUST produce implementation code, not just exploration." but this is template-based, not intelligent.
4. **MCP server lifecycle**: Currently the MCP server is a stdio child of the host agent. If the host agent dies, so does the server. For server-driven loops, the server needs to be a persistent daemon — either background process or systemd/launchd service.
5. **Notification mechanism**: When the server completes a job cycle autonomously, how does it notify the user? MCP protocol doesn't have server→client push. Options: write to steer inbox (agent reads on next interaction), filesystem watcher, or the server exposes a web dashboard.

### Observations from job-10 failure relevant to server-side loop
- Worker exited 0 (success) but deliverables were missing → server needs post-completion deliverable check
- Orchestrator correctly identified the problem via manual inspection → this judgment needs to be mechanized
- Retry with same job_id was rejected → need `tenet_retry_job` that resets status to pending
- Ad-hoc workaround broke DAG tracking → server must maintain DAG integrity on retries

## Session 2 — Continued Testing with Claude Code

### Context
Switched from OpenCode to Claude Code after exhausting Copilot usage. Ran Claude Code in `tenet-manual-test/` with prompt: `/tenet I force quit the session before so let's continue from where we left off`.

### Observations

| # | Observation | Assessment |
|---|---|---|
| 21 | Claude Code picked up where the session left off after `/tenet` prompt | Session resumption via `.tenet/` state works across different host agents (OpenCode → Claude Code). The portable SQLite + markdown state design is validated. |
| 22 | Claude Code blocked on foreground wait instead of background | Same issue as #8 — the agent is calling `tenet_job_wait` in blocking/foreground mode. The non-blocking wait pattern isn't being followed. This confirms the problem isn't OpenCode-specific; it's a SKILL.md instruction issue (or the instructions get ignored). |
| 23 | No visible activity indicator — unclear if agent is working or stuck | When waiting in foreground, there's no feedback to the user. Directory size unchanged over 10+ seconds of monitoring. The agent appears fully stalled, not doing background work. User can't distinguish "working" from "hung". |

### Analysis

**#21 — Cross-agent portability confirmed.** This is a strong validation point. The `.tenet/` directory is truly the source of truth, and any MCP-compatible host agent can pick it up. This is exactly the design intent.

**#22 — Foreground blocking is a recurring pattern, but the tool itself is already non-blocking.**

`tenet_job_wait` already returns instantly (calls `checkJobStatus()`, no polling). The SKILL.md (lines 237-250 in `phases/05-execution-loop.md`) explicitly instructs agents to:
- Dispatch `tenet_job_wait` as a **BACKGROUND** task
- Poll with 30s→120s exponential backoff
- Remain responsive to user steering between polls

Yet both OpenCode (after compaction) and Claude Code (fresh start) ignore these instructions and block in the foreground. This means the problem is **agent instruction-following**, not tool design. Possible causes:
- The BACKGROUND dispatch pseudocode isn't translating into what agents actually do — "BACKGROUND" isn't a concept they reliably map to their own tool-calling patterns
- Claude Code may not support background tool dispatch at all (unlike OpenCode's `schedule` primitive), so the instruction is impossible to follow
- The tool name `tenet_job_wait` implies "wait" which biases the agent toward blocking behavior regardless of instructions

**Key question: Does Claude Code even have a mechanism to call an MCP tool in the background and continue interacting with the user?** If not, the SKILL.md's BACKGROUND pattern is architecturally impossible, and we need a different approach entirely.

**#23 — No activity indicator — user can't distinguish working from hung.**

Directory size unchanged over 10+ seconds. The agent appears fully stalled. This is compounded by the foreground blocking (#22) — if the agent is in a tight poll loop, it's not printing status. If it's genuinely hung, there's no heartbeat to prove otherwise.

Possible fixes:
- The SKILL.md poll loop includes `TELL USER: "{job.name}: {result.progress_line}"` — this instruction is being skipped along with the rest of the background pattern
- Even if foreground-blocked, the agent should print something between `tenet_job_wait` calls
- **Server-side approach**: MCP server could include a `last_activity` timestamp or heartbeat in `tenet_job_wait` responses, so at minimum the user sees "worker last active 5s ago" vs "worker last active 3 min ago" — giving a mechanical stuck-detection signal
