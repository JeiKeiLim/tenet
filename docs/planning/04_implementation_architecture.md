# Tenet: Implementation Architecture
## From Design to Code — Decisions, Patterns, and Lessons

Version: 0.4.0
Date: 2026-04-06
Status: Pre-implementation
Predecessor: 03_merged_and_improved_by_claude.md (v0.3 Design Spec)

---

### Section 1: Architecture Overview

Tenet is not a standalone application. It's a system composed of three core components that turn a coding agent into an autonomous development orchestrator.

1.  **SKILL.md (The Brain)**: Instructions that tell the coding agent how to orchestrate the Tenet loop. The agent reads these and follows them like a script. It contains the main loop pseudocode, phase transitions, and decision logic.
2.  **MCP Server (The Engine)**: A background process that handles long-running operations like evaluation, compilation, tests, and bootstrap context compilation. It exposes tools that the agent calls. It runs heavy work asynchronously to prevent blocking the agent's main thread.
3.  **.tenet/ Directory (The Knowledge Layer)**: Persistent markdown files that serve as the project's documentation and knowledge. These are human-readable, git-trackable, and team-shareable. This is the persistent state of the project, not ephemeral memory.

**How they work together:**
The agent reads instructions from `SKILL.md` and begins the loop. When it needs to perform a heavy task, it calls an MCP tool. The MCP server executes the task in the background. The agent polls the server for results using a long-poll pattern, which keeps the session active and prevents timeouts. Once results are available, the agent writes findings to `.tenet/` files and continues to the next step in the loop.

---

### Section 2: How the Long-Running Loop Works

Tenet achieves long-running autonomy using a mechanism proven by Q00/ouroboros's Ralph skill, which has been validated running 3+ hours without human intervention.

**The mechanism has three parts:**

1. **SKILL.md as executable directive**: The skill file contains explicit loop pseudocode. When Claude Code or OpenCode loads the skill, it interprets the pseudocode as instructions to execute — not documentation to reference. The agent follows it like a program, making tool calls in sequence without waiting for human input.

2. **MCP background jobs + long-poll**: Heavy operations run in the MCP server's event loop as asyncio tasks. The agent doesn't wait for completion synchronously — it polls using `tenet_job_wait(job_id, cursor, timeout=120)`. The 120-second long-poll timeout means there is always an active tool call in flight, preventing the agent's session from timing out due to inactivity.

3. **Decision signals in tool responses**: Each `job_wait` response includes structured metadata (`status`, `cursor`) that tells the agent whether to continue polling, process results, or handle an error. The agent doesn't need to "decide" to continue — the skill pseudocode dictates the control flow based on the status value.

**Loop Pseudocode:**

```python
while jobs_remaining():
    job = pick_next_job_from_dag()
    compiled_context = tenet_compile_context(job)
    
    # Start dev session as background job
    result = tenet_start_job(job, compiled_context)
    job_id = result.job_id
    
    # Poll until complete (keeps session alive)
    while not terminal:
        status = tenet_job_wait(job_id, cursor, timeout=120)
        cursor = status.cursor
        terminal = status.is_terminal
    
    # Get result and evaluate
    output = tenet_job_result(job_id)
    eval_result = tenet_start_eval(job, output)
    
    # Poll eval (ALSO backgrounded — never foreground)
    while not eval_terminal:
        eval_status = tenet_job_wait(eval_result.job_id, cursor, timeout=120)
        eval_terminal = eval_status.is_terminal
    
    eval_output = tenet_job_result(eval_result.job_id)
    
    if eval_output.passed:
        tenet_update_knowledge(job, output)
        tenet_update_status(job, "completed")
    else:
        tenet_reflect(job, eval_output)
        # Stagnation detection, persona rotation, etc.
    
    # Check steer inbox
    tenet_process_steer()
```

This architecture allows a user to start a session, walk away, and return hours later to find the agent still making progress on the dependency graph.

**Why it works**: The session never goes idle. Each `job_wait` call keeps the connection alive for up to 120 seconds. When it returns, the agent immediately processes the result and either polls again or moves to the next step. From the platform's perspective, the agent is continuously active — making tool calls, receiving results, and making decisions. There is no idle window long enough to trigger any platform timeout.

**Evidence**: Q00/ouroboros's Ralph skill (`skills/ralph/SKILL.md`) uses this exact pattern. The skill pseudocode contains a `while iteration < max_iterations` loop with nested `job_wait` polling. Users have confirmed 3+ hour autonomous runs without any human interaction.

---

### Section 3: Lessons from Ouroboros (Q00/ouroboros)

Tenet incorporates lessons from the Ouroboros rewrite (Q00/ouroboros).

**What Ouroboros gets right:**
*   `SKILL.md` with loop pseudocode drives autonomous execution.
*   MCP server handles background work via a `JobManager`.
*   Event sourcing with SQLite enables stateless session resumption.
*   Long-poll pattern keeps sessions alive during long tasks.

**What Ouroboros gets wrong (Tenet's fixes):**

#### Problem 1: Foreground eval blocking
In Ouroboros, `EvaluateHandler` (`evaluation_handlers.py:312-509`) runs synchronously without a background mode. It runs a 3-stage pipeline (mechanical verification + semantic eval + consensus) that takes 1-4 minutes. `TIMEOUT_SECONDS = 0` means no server-side timeout. Claude's MCP call blocks for the entire duration. If eval takes longer than the MCP client timeout, Claude appears to hang indefinitely.

Meanwhile, `StartExecuteSeedHandler` (`execution_handlers.py:850`) correctly wraps execution in `JobManager.start_job()` — proving the codebase already has the pattern, it just wasn't applied to eval.

*   **Tenet fix**: Every operation exceeding 2 seconds must be a background job. No exceptions. The MCP server enforces this architecturally — a wrapper that auto-backgrounds any operation exceeding a threshold.

#### Problem 2: Stale or missing IDs
Ouroboros lacks a centralized ID registry. Validation is inconsistent across handlers:
- `EvolveRewindHandler` (`evolution_handlers.py:501-507`) checks for empty lineage and returns a clear error
- `EvolveStepHandler` (`evolution_handlers.py:248`) does NOT check — passes invalid IDs deep into `evolve_step()`, causing cryptic failures

As the event store grows with more iterations, more IDs exist, and Claude's context can't reliably track them all. A stale lineage_id from a previous session causes the system to fail in ways that are hard to diagnose.

*   **Tenet fix**: Server-side session state. The MCP server tracks the current project, current job, and all active IDs. The agent doesn't need to pass IDs around — it calls `tenet_continue()` and the server knows what's active. This eliminates the stale ID problem entirely.

#### Problem 3: Context bloat from polling
Each `job_wait` in Ouroboros returns a full snapshot via `_render_job_snapshot()` (`job_handlers.py:227-254`): job metadata (9 lines), execution details (6 lines), recent subtasks (up to 3, ~3 lines each), lineage status (4-6 lines). Approximately 500-1000 bytes per response.

Over a 3-hour run: 120s poll timeout → ~360 polls × ~800 bytes = **~300KB** of accumulated context just from job status polling. This doesn't include Claude's own poll requests. The result: Claude's context fills with redundant status data, leaving less room for actual reasoning.

*   **Tenet fix**: Minimal poll responses. `job_wait` returns only `{status, progress_line, cursor}` (~50 bytes). Full output is retrieved only once via `job_result` on completion. This reduces polling context from ~300KB to ~18KB over 3 hours — a 15x improvement.

#### Problem 4: MCP server restart kills all projects
A single MCP server process is shared across projects. A restart or crash affects every active run.
*   **Tenet fix**: Per-project MCP server instances. Each project has an isolated process, database, and state.

#### Problem 5: In-memory job state lost on restart
The Ouroboros `JobManager` (`job_manager.py:65-85`) tracks jobs in Python dictionaries: `_tasks`, `_runner_tasks`, `_monitors`, `_known_job_ids` — all in-memory only. The EventStore persists events to SQLite, but the job-to-task mapping does not survive a restart. An MCP restart orphans all running jobs — the events say "job running" but no asyncio task exists to complete it.

Additionally, `EventStore.get_events_after()` (`event_store.py:275`) returns ALL events since a cursor with no LIMIT clause. As the event store grows to 500+ events over 3 hours, state reconstruction becomes progressively slower.

*   **Tenet fix**: Job state persisted to storage. On restart: reconstruct active jobs from persistent state, detect orphaned jobs, mark them as interrupted with clear status. Event compaction or snapshots to bound reconstruction time.

#### Problem 6: No stall detection
If a background job hangs, Claude polls forever receiving a "running" status.
*   **Tenet fix**: Heartbeat-based stall detection. If a job emits no events for a configured period, it auto-fails, giving the agent a clear signal.

---

### Section 4: Seven Structural Improvements Over Ouroboros

1.  **Mandatory background execution**: All operations >2s are wrapped in jobs with server-side timeouts (default 5 min).
2.  **Per-project MCP server isolation**: Each project gets its own process and state via `tenet serve --project /path`.
3.  **Minimal poll responses**: `job_wait` returns ~50 bytes per call, reducing context bloat by 15x.
4.  **Server-side session state**: The server tracks the current project and active jobs. The agent uses `tenet_continue()` instead of managing complex ID lists.
5.  **Heartbeat stall detection**: Jobs must emit periodic events. Silence leads to auto-failure and agent notification.
6.  **Parallel agent concurrency control**: Configurable `max_parallel_agents` (default 2). The MCP server enforces a semaphore on job dispatch — if all slots are full, jobs queue. This prevents token usage spikes that hit subscription rate limits.
7.  **Multi-agent dispatch**: The MCP server can dispatch jobs to different coding agents (Claude Code, Codex, OpenCode/Copilot) based on configuration. See Section 7.1 for details.

---

### Section 5: State Management — Two Layers

**Layer 1: .tenet/ directory (Persistent, Human-Readable)**
This is the knowledge layer that survives across machines and sessions. It contains:
*   Spec, harness, and interview results.
*   Confidence-tagged knowledge docs.
*   Status tracking and job definitions.
*   Steer inbox with status tracking.
*   Visual artifacts (HTML).
*   Lessons learned and `index.md`.

**Layer 2: MCP server operational state (Ephemeral, Machine-Local)**
This is the execution layer used for runtime management, stored in **SQLite**. It contains:
*   Active job tracking (job IDs, status, agent assignment, started_at).
*   Event log for crash recovery and session resumption.
*   Cursors and poll state.
*   Heartbeat timestamps.
*   Concurrency slot tracking.

SQLite is chosen for its atomic writes, fast event replay queries, and zero-configuration setup. This data is NOT meant for human reading or team sharing — it's the MCP server's internal bookkeeping. If the SQLite file is deleted, the MCP server can reconstruct minimal state from `.tenet/status/` and start fresh.

---

### Section 6: Cross-Platform Compatibility

Tenet uses a core-plus-adapter architecture.

*   **Shared Component**: The MCP server is platform-agnostic, written in TypeScript using the `@modelcontextprotocol/sdk` package. Distributed via npm.
*   **Platform-Specific**: `SKILL.md` instructions may have slight variations to handle specific agent behaviors.

| Platform | Skill Location | MCP Config | Status |
| :--- | :--- | :--- | :--- |
| Claude Code | `.claude/skills/tenet/SKILL.md` | `.claude/.mcp.json` | Primary |
| OpenCode | `.claude/skills/tenet/SKILL.md` | `.opencode.json` | Primary |
| Codex | `.agents/skills/tenet/SKILL.md` | TBD | Future |
| Copilot CLI | `.github/copilot-instructions.md` | TBD | Future |

OpenCode natively reads `.claude/skills/`, allowing a single skill to target both primary platforms.

---

### Section 7: MCP Server Tool Design

#### 7.1 Multi-Agent Dispatch

The MCP server is a **multi-agent orchestrator** — it dispatches jobs to different coding agents based on configuration. This is critical for two real-world scenarios:

**Scenario A: Rate limit fallback.** User hits Claude subscription limit mid-run. Instead of stopping, the MCP server switches to Codex for remaining jobs until the Claude limit resets.

**Scenario B: Workplace constraints.** User's workplace doesn't support Claude but has GitHub Copilot. The MCP server dispatches via OpenCode with Copilot as the backend.

**Agent Adapter Interface:**

Each supported agent implements a common adapter:

```
AgentAdapter
├── invoke(prompt, context, max_turns) → result
├── is_available() → bool
├── estimate_cost(prompt) → tokens
└── name → str
```

Adapters:
- `ClaudeCodeAdapter` — **Two modes.** (1) CLI mode: invokes `claude --print --max-turns N` via child_process — uses Pro/Max subscription, no separate API key needed. (2) SDK mode: uses `@anthropic-ai/claude-agent-sdk` — requires separate `ANTHROPIC_API_KEY` with pay-per-token billing. The SDK cannot use subscription (GitHub Issue #559). CLI mode is preferred for subscription users.
- `CodexAdapter` — **Two modes.** (1) CLI mode: invokes `codex exec "prompt"` via child_process — uses ChatGPT Plus/Pro/Team/Enterprise subscription via `codex login` OAuth. Credentials stored in `~/.codex/auth.json`. (2) API mode: uses `openai` npm with `OPENAI_API_KEY` — separate pay-per-token billing. CLI mode is preferred for subscription users. Usage limits reset every 5 hours (Plus: 45-225 messages, Pro: 300-1500).
- `CopilotAdapter` — Uses `@github/copilot-sdk` (Public Preview). **Default uses existing Copilot subscription** (Individual/Business/Enterprise). CLI bundled with SDK. Supports streaming, session resume, `approveAll` for auto-permissions. BYOK (Bring Your Own Key) is optional — only needed to bypass Copilot and use your own provider directly.
- `OpenCodeAdapter` — CLI-based (`opencode -p "prompt" -f json -q`). Spawns child process. **Can use any provider's subscription via OAuth** (Claude Pro/Max, ChatGPT Plus/Pro, Copilot) — making it the universal subscription-based fallback. Also supports `opencode serve` for persistent server mode. No official SDK, no streaming.
- (Future adapters as new agents emerge)

**Billing summary:**

All four agent products support subscription-based billing. API keys are the alternative path for CI/CD or pay-per-token use.

| Adapter | Subscription Mode | API Key Mode |
| :--- | :--- | :--- |
| Claude Code | `claude` CLI → Pro/Max subscription | Agent SDK → ANTHROPIC_API_KEY |
| Codex | `codex exec` CLI → ChatGPT Plus/Pro/Team | `openai` npm → OPENAI_API_KEY |
| Copilot | SDK default → Copilot subscription | BYOK → your own provider key |
| OpenCode | CLI → any provider's subscription via OAuth | CLI → provider API keys |

Default should prefer subscription-based paths to avoid unexpected billing. The adapter config should let users choose per-agent.

**Configuration (per project):**

```yaml
# .tenet/config.yaml or MCP server config
agents:
  default: claude-code
  fallback: codex          # Use when default hits rate limit
  
  # Override per job type
  overrides:
    dev: claude-code       # Development jobs use Claude
    eval: claude-code      # Eval also uses Claude (or a cheaper model)
    mechanical_eval: local # Lint/test runs locally, no agent needed

concurrency:
  max_parallel_agents: 2   # Max simultaneous agent invocations
```

The MCP server's job dispatcher checks adapter availability before dispatch. If the configured agent is unavailable (rate limited, not installed), it falls back to the next configured adapter.

**Concurrency control:**

A semaphore limits how many agents run simultaneously:

```python
# Pseudocode
semaphore = asyncio.Semaphore(max_parallel_agents)

async def dispatch_job(job):
    async with semaphore:  # Blocks if all slots full
        adapter = select_adapter(job.type)
        result = await adapter.invoke(job.prompt, job.context)
        return result
```

This is critical because:
- Parallel agents burn tokens fast — 3 agents in parallel can exhaust a Claude Pro subscription in under an hour
- The user controls the trade-off: `max_parallel_agents: 1` = slow but cheap, `max_parallel_agents: 5` = fast but expensive
- Jobs queue when slots are full — no work is lost, just delayed

#### 7.2 Tool API

**Job Lifecycle:**
*   `tenet_start_job(job_type, params)`: Returns `job_id` immediately.
*   `tenet_job_wait(job_id, cursor, timeout_seconds=120)`: Long-poll for minimal status.
*   `tenet_job_result(job_id)`: Retrieves full output upon completion.
*   `tenet_cancel_job(job_id)`: Terminates a running job.

**Tenet-Specific Tools:**
*   `tenet_init(project_path)`: Initializes the `.tenet/` directory.
*   `tenet_continue()`: Resumes from the server-tracked current state.
*   `tenet_compile_context(job_id)`: Compiles the bootstrap context for a job.
*   `tenet_start_eval(job_id, output)`: Starts the evaluation pipeline as a background job.
*   `tenet_update_knowledge(job_id, findings)`: Writes findings to knowledge docs.
*   `tenet_process_steer()`: Checks and processes `steer/inbox.md`.
*   `tenet_health_check()`: Runs a document health audit.
*   `tenet_get_status()`: Returns a minimal, human-readable project summary.
*   `tenet_set_agent(job_type, agent_name)`: Change agent assignment at runtime (e.g., switch from Claude to Codex mid-run).

---

### Section 8: Design Decisions from Conversation

**Round 1: Core Design Refinements**
*   Harness is a strict engineering quality contract (linting, tests, architecture rules).
*   Budget references are removed; assume unlimited resources.
*   Mockups expanded to include architecture diagrams, flow diagrams, and data models.
*   Job decomposition is based on complexity and logical cohesion, not arbitrary line limits.

**Round 2: New Mechanisms**
*   Visualizations are self-contained HTML files (native medium for agents).
*   Steer inbox uses inline status tracking (`received` → `acknowledged` → `acted_on` → `resolved`).
*   Auto-generated `index.md` acts as a table of contents and health surface.
*   Zero-findings critic rule: a clean report triggers a mandatory re-analysis.

**Round 3: Gaps Filled**
*   Scale-adaptive modes: Full, Standard, and Quick. Quality gates remain constant across all modes.
*   Catastrophic recovery: Corruption or major violations trigger halts and reverts.

**Round 4: Architecture Discovery**
*   Brain (Skill) + Engine (MCP) + Knowledge (.tenet/) structure.
*   Long-running loop via skill pseudocode and long-polling.
*   Per-project MCP server isolation.
*   Heartbeat stall detection.

**Round 5: Implementation Decisions**
*   MCP server language: **TypeScript** — native to Claude Code ecosystem, first-class MCP SDK support, npm distribution.
*   Operational state storage: **SQLite** — for event store, job tracking, cursors. Knowledge stays in .tenet/ markdown.
*   MCP server lifecycle: **Auto-start** — SKILL.md checks if per-project server is live; if not, launches it via bash.
*   Session resumption: **Open** — both MCP server and agent session can die independently. SKILL.md checks .tenet/status/ and MCP health on startup. Exact flow needs prototyping.
*   Parallel jobs from DAG: **Yes** — independent jobs run in parallel, each consuming a concurrency slot. DAG dependency edges are the constraint.
*   Context window management: **User's choice** — Tenet suggests checkpointing but doesn't force compaction or fresh sessions.
*   MCP server monitoring: **Both** — `tenet_get_status()` MCP tool for in-agent health checks, plus `tenet status` CLI for independent monitoring.
*   Multi-agent dispatch: **Configurable per job type** with fallback on rate limit. Agent adapters for Claude Code, Codex, Copilot/OpenCode.
*   Agent capability routing: **No** — just use the configured mapping. Agents share similar features.
*   Concurrency control: **Simple `max_parallel_agents` count** (default 2). Semaphore on job dispatch.
*   Agent adapter SDKs: **Researched and confirmed.** All four agent products support subscription-based billing via CLI invocation. API keys are the alternative for CI/CD or pay-per-token. See Section 7.1 for full billing breakdown.

| Adapter | Subscription Mode | API Key Mode |
| :--- | :--- | :--- |
| Claude Code | `claude` CLI → Pro/Max | Agent SDK → ANTHROPIC_API_KEY |
| Codex | `codex exec` CLI → ChatGPT Plus/Pro/Team | `openai` npm → OPENAI_API_KEY |
| Copilot | SDK default → Copilot subscription | BYOK → provider key |
| OpenCode | CLI → any provider subscription via OAuth | CLI → provider API keys |

---

### Section 9: Inspirations and References

**BMAD-Method** (bmad-code-org/BMAD-METHOD, 43K+ stars):
- Scale-adaptive intelligence (quick dev / standard / enterprise) → inspired Tenet's three execution modes
- Adversarial review ("zero findings = re-analyze") → adopted as zero-findings critic rule
- Sharding + constitution file (project-context.md) → influenced document architecture and index.md
- Separation of canonical source and IDE integration → influenced core + platform adapter pattern
- Story-based task tracking with YAML status → influenced job status tracking design

**Ouroboros — Q00/ouroboros** (the rewrite):
- SKILL.md with loop pseudocode (Ralph skill) driving autonomous execution → adopted as Tenet's core loop mechanism
- MCP server + JobManager + background jobs + long-poll → adopted as Tenet's engine pattern
- Event sourcing (SQLite EventStore) for crash recovery and session resumption → informing operational state design
- `job_wait` with 120s timeout long-poll → adopted for session keepalive
- Failures (foreground eval, stale IDs, context bloat, shared server, in-memory state loss, no stall detection) → all identified as problems with specific fixes

**Ouroboros — razzant/ouroboros** (the original):
- Infinite supervisor loop (`colab_launcher.py`) with adaptive sleep (0.1-0.5s) → conceptually similar to Tenet's DAG-driven loop
- Auto-task generation when queue is empty (`enqueue_evolution_task_if_needed`) → influenced the "always have work" principle
- Background consciousness daemon thread (proactive thinking between tasks) → potential future feature
- Persistent multiprocessing worker pool with auto-respawn → influenced heartbeat stall detection design
- Timeout enforcement with automatic retry → influenced job timeout strategy

**Research papers and industry sources** (detailed in 03_merged_and_improved_by_claude.md Section 0):
- Zylos Research (2026): Error compounding in long-running agents
- SWE-bench Pro (arXiv:2509.16941): Failure pattern taxonomy
- Manus context engineering: KV-cache optimization, leave wrong turns in context
- Google ADK: Compiled-view pattern for context management
- "Lost in the Middle": U-shaped attention performance curve

---

### Section 10: Open Questions (Remaining)

Resolved questions have been moved to Section 8 "Round 5: Implementation Decisions."

1.  **Session resumption after dual failure**: Both MCP server and agent session can die independently. When the user starts a new session, SKILL.md needs to handle: (a) MCP server alive + work in progress → resume, (b) MCP server dead + .tenet/ intact → restart server + resume from status, (c) MCP server dead + .tenet/ corrupted → catastrophic recovery via git. The exact detection and recovery flow needs prototyping.
2.  **Rate limit detection**: How does the MCP server detect that an agent has hit its rate limit? Claude Agent SDK returns cost data and may throw rate limit errors. OpenAI API returns HTTP 429 with `Retry-After` header. Copilot SDK behavior TBD. Each adapter needs rate limit detection logic.
3.  **Testing the SKILL.md**: How to verify that skill instructions work correctly before committing to a long run? Possibly a "dry run" mode that executes the loop but with mock MCP responses.
4.  **Distribution**: How do users install Tenet? `npx tenet init`? Git clone? npm package? This affects how the SKILL.md, MCP server binary, and templates are delivered.
5.  **SKILL.md MCP server auto-launch**: The exact mechanism for SKILL.md to detect a dead MCP server and launch it. Likely a bash tool call (`tenet serve --project . --background`), but needs to handle port conflicts, multiple projects, and error cases.
6.  **OpenCode adapter limitations**: OpenCode has no SDK, only CLI. No streaming, no max_turns. May need a wrapper that polls for completion. Server mode (`opencode serve`) may help with cold boot time but needs investigation.

---

### Section 11: Validation Strategy

The validation strategy relies on manual testing with a real project using the URL Shortener scenario from `scenario-walkthrough.html` as a prototype.

**Next Steps:**
1.  Build a minimal `SKILL.md` and MCP server.
2.  Execute a run on a small, real-world project.
3.  Iterate on the loop and tool responses based on failures.

---

### Appendix A: File Inventory

```
docs/planning/
├── 01_initial_prd.md                           — Original PRD (v0.1), historical
├── 02_adverserial_review_improvements.md       — Adversarial review (v0.2), historical
├── 03_merged_and_improved_by_chatgpt.md        — ChatGPT merge (v0.2), historical
├── 03_merged_and_improved_by_claude.md         — Claude merge (v0.3), active design spec
├── 04_implementation_architecture.md           — THIS DOCUMENT (v0.4), implementation decisions
├── scenario-walkthrough.html                   — Interactive scenario walkthrough
├── review-dashboard.html                       — Design review dashboard
└── tenet-flow.html                             — System flow diagram
```
