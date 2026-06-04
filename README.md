# Tenet

![](docs/assets/tenet-logo.png)

> **T**alk. **E**stablish. **N**onstop. **E**valuate. **T**enet.

**Cross-platform AI agent plugin for 12+ hour autonomous development cycles.**

*tenet* — a principle held to be true. Also a palindrome: it reads the same forward and backward, just like the process. **Talk** through what you want. **Establish** the spec and plan. **Nonstop** execution through the DAG. **Evaluate** every line with independent critics. Each cycle produces a **tenet** — a verified feature that feeds the next cycle.

```
You: "Add social features — reactions, badges, user profiles, share cards"
Tenet: interviews you, writes the spec, generates visual mockups,
       decomposes into a dependency graph, implements each job,
       asks workers to commit per job, evaluates with 3 independent critics,
       and loops for 6+ hours until everything passes.
```

## Why Tenet?

AI coding agents are powerful but short-lived. They lose context, drift off-spec, skip tests, and can't sustain multi-hour development sessions. Tenet solves this:

- **Structured phases** — Brownfield scan, Interview, Spec, Visuals, Decomposition, Execution, Evaluation, and Agile checkpoints. No required phase is skippable.
- **DAG-based job orchestration** — Dependencies are explicit. Parallel jobs run in parallel. Blocked jobs wait.
- **3-critic evaluation pipeline** — Code critic, Test critic, and Playwright e2e eval. All independent, all with fresh context (no author bias). All findings are blocking.
- **Crash recovery** — Server-ID-based orphan detection. If the MCP server dies, jobs auto-retry on restart.
- **Agent-agnostic** — Works with Claude Code, OpenCode, and Codex. Switch agents mid-project without losing state.
- **Persistent state** — Versioned SQLite + WAL mode. Jobs, events, steer messages, and config survive crashes.

## Built With Tenet

See [Built With Tenet](docs/built-with-tenet.md) for real projects produced while testing Tenet, including their `.tenet/` artifacts, critic feedback, retry trails, and validation notes.

## Quick Start

```bash
# Install globally
npm install -g @jeikeilim/tenet

# Initialize a project
cd your-project
tenet init

# That's it. Start your coding agent and invoke the tenet skill:
# In Claude Code: /tenet "Add user authentication with OAuth"
# In Codex: use the tenet skill
```

### One-liner (skip interactive prompts)

```bash
npx @jeikeilim/tenet init --agent claude-code --skip-playwright-check
```

## How It Works

### The 8 Phases

| Phase | What Happens |
|-------|-------------|
| **0. Brownfield Scan** | Detects existing code, frameworks, and prior tenet work |
| **1. Interview** | Agent asks clarifying questions, researches technologies |
| **2. Spec & Harness** | Writes formal spec with scenarios + quality contract |
| **3. Visuals** | Generates architecture diagrams, UI mockups, DESIGN.md |
| **4. Decomposition** | Breaks spec into a dependency graph (DAG) of jobs |
| **5. Execution Loop** | Implements each job, prompts per-job commits, evaluates, retries on failure |
| **6. Evaluation** | 3 independent critics: code, tests, and Playwright e2e |
| **7. Agile Checkpoints** | Handles plan/use checkpoints and redirect loops in agile mode |

### The Evaluation Pipeline

Every completed job faces three independent critics, each with fresh context and no access to the author's reasoning:

```
Job Complete
    |
    +---> Code Critic    (spec alignment, security, edge cases)
    +---> Test Critic     (oracle problem detection, behavioral coverage)
    +---> Playwright Eval (scripted tests + agent-driven exploratory e2e)
    |
    ALL must pass --> Next job
    ANY fails     --> Retry with failure context
```

**The Oracle Problem**: Research shows AI-written tests have ~6% precision when the same agent writes both code and tests. Tenet's test critic explicitly checks for oracle leakage — tests that verify implementation behavior rather than intended behavior.

### Steer Messages

Redirect the agent mid-run without breaking the loop:

```
You: "Focus on the API first, skip the frontend for now"
Tenet: classifies as directive, adjusts job priority, continues
```

Three classes: `context` (informational), `directive` (priority change), `emergency` (halt everything).

## Architecture

```
                    +-----------------+
                    |  Coding Agent   |  (Claude Code / OpenCode / Codex)
                    |  + Tenet Skill  |
                    +--------+--------+
                             |
                         MCP Protocol
                             |
                    +--------v--------+
                    |   MCP Server    |  18 tools (start_job, eval, steer, etc.)
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v--------+
     | Job Manager|  | State Store |  | Adapters    |
     | (DAG, retry|  | (SQLite+WAL)|  | (subprocess)|
     | heartbeat) |  |             |  |             |
     +------------+  +-------------+  +-------------+
                                       claude --print
                                       opencode run
                                       codex exec --sandbox workspace-write
```

**Four layers:**

1. **Core** — Job orchestration with DAG execution, heartbeat stall detection, configurable retry logic, and server-ID crash recovery
2. **Adapters** — Pluggable agent adapters that spawn CLI subprocesses. 120-minute default timeout, configurable.
3. **MCP Server** — 18 tools via `@modelcontextprotocol/server`. Zod-validated inputs.
4. **CLI** — `init`, `serve`, `status`, `config` commands. Scaffolds `.tenet/`, copies skills to agent-specific locations, and runs explicit DB upgrades.

## CLI Reference

```bash
# Initialize project (interactive agent selection + optional Playwright MCP install)
tenet init [path]
tenet init --agent claude-code --skip-playwright-check
tenet init --upgrade  # Update DB, skills/configs, preserve your docs

# Start MCP server
tenet serve
tenet serve --background

# Check project status
tenet status
tenet status --all  # Include completed/failed jobs

# SQLite state maintenance
tenet db check      # Read-only integrity/index diagnostics
tenet db backup     # Verified SQLite-safe backup

# Configure
tenet config                          # View current config
tenet config --agent claude-code      # Set default agent
tenet config --max-retries unlimited  # Default: no fixed retry cap
tenet config --max-retries 5          # Optional finite retry limit
tenet config --timeout 120            # Set job timeout (minutes)
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `tenet_init` | Initialize a project from MCP |
| `tenet_compile_context` | Gather spec, harness, status, and knowledge into a single context |
| `tenet_validate_clarity` | Score the interview transcript before spec generation |
| `tenet_validate_readiness` | Score implementation readiness before decomposition |
| `tenet_register_jobs` | Load a job DAG with dependencies |
| `tenet_start_job` | Execute a single job via agent adapter |
| `tenet_continue` | Get the next actionable job from the DAG |
| `tenet_job_wait` | Check or long-poll job status |
| `tenet_job_result` | Retrieve job output and status |
| `tenet_retry_job` | Reset a failed/completed job to pending |
| `tenet_cancel_job` | Cancel a running or pending job |
| `tenet_start_eval` | Dispatch code critic + test critic + playwright eval |
| `tenet_report_blocking_finding` | Let report-only jobs pause and spawn a linked follow-up job |
| `tenet_update_knowledge` | Write knowledge/journal entries |
| `tenet_add_steer` | Submit a steer message (context/directive/emergency) |
| `tenet_process_steer` | Acknowledge and act on steer messages |
| `tenet_health_check` | Verify system consistency |
| `tenet_get_status` | Get current job counts and progress |

## Project Structure

After `tenet init`, your project gets:

```
your-project/
  .tenet/
    interview/      # Interview transcripts (dated per feature)
    spec/           # Formal specifications
    harness/        # Quality contracts (linting, testing, architecture rules)
    status/         # Auto-generated status files
    knowledge/      # Reusable technical knowledge
    journal/        # Dev activity logs
    steer/          # Steer message inbox/processed
    visuals/        # Architecture diagrams, UI mockups
    bootstrap/      # Compiler/build configuration
    .state/
      tenet.db      # Versioned SQLite state (jobs, events, steer, config)
      config.json   # Project configuration
  .mcp.json         # Claude Code MCP server configuration (auto-generated)
  .codex/config.toml # Codex MCP server configuration and project trust
  opencode.json     # OpenCode MCP server configuration and permissions
  .claude/skills/tenet/  # Generated skill files for Claude Code, with Tenet version metadata
  .agents/skills/tenet/  # Generated skill files for Codex, with Tenet version metadata
```

## Execution Modes

| Mode | Phases | Use Case |
|------|--------|----------|
| **Full** (default) | All 8 phases | New features, major refactors |
| **Standard** | Skip interview (use existing spec) | Spec already written |
| **Quick** | Skip interview + spec + decomposition | Bug fixes, small changes |

## Crash Recovery

Tenet is designed for long autonomous runs where crashes are expected:

- **Server restart**: Stale "running" jobs are reset to "pending" only after their heartbeat exceeds the timeout
- **Adapter timeout**: 120-minute default (configurable), prevents zombie subprocesses
- **Heartbeat monitoring**: Detects truly stuck jobs within a session
- **MCP disconnect**: Skill instructs agents to attempt server restart, halt if unrecoverable
- **Update checks**: Health/status can surface newer npm versions with manual upgrade guidance; Tenet does not auto-update during an active run
- **DB upgrades**: Normal startup refuses old/newer DB schemas with guidance. Close the agent, run `tenet init --upgrade`, then restart; upgrade creates a verified SQLite-safe DB backup first.

## Diagnostics

When things go wrong, use the `tenet:diagnose` skill:

```bash
# Or manually inspect:
sqlite3 .tenet/.state/tenet.db "SELECT type, status, COUNT(*) FROM jobs GROUP BY type, status"
sqlite3 .tenet/.state/tenet.db "SELECT * FROM jobs WHERE status='failed'"
```

The diagnose skill provides 10 diagnostic sections with ready-to-run queries for job status, event logs, config, git-DB desync detection, and more.

## Agent Compatibility

| Agent | Status | Notes |
|-------|--------|-------|
| Claude Code | Fully supported | Primary development target |
| OpenCode | Supported | Skill and MCP discovery via opencode.json |
| Codex | Supported | `--sandbox workspace-write` by default, `.codex/config.toml` for MCP |

## Requirements

- Node.js >= 20
- At least one AI coding agent CLI installed (`claude`, `opencode`, or `codex`)
- Optional: Playwright MCP for browser/visual e2e testing (`tenet init` offers to install it and writes each supported agent config)

## Development

```bash
git clone https://github.com/JeiKeiLim/tenet
cd tenet
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

### Doc/Code Consistency Review

This repository includes a maintainer-only AI review script that checks current Markdown docs against code-derived facts such as MCP tool names, CLI options, adapter defaults, and runtime defaults. It is not shipped in the npm package and it does not apply fixes. When multiple reviewers are used, their raw findings are preserved and a final synthesizer groups duplicate or overlapping findings into merged issues.

Run the normal review with Claude:

```bash
make docs-review
```

Pass custom review arguments through `DOCS_REVIEW_ARGS`:

```bash
# Use a different reviewer
DOCS_REVIEW_ARGS="--agents codex" make docs-review
DOCS_REVIEW_ARGS="--agents opencode" make docs-review

# Use combinations
DOCS_REVIEW_ARGS="--agents claude,codex" make docs-review
DOCS_REVIEW_ARGS="--agents claude,codex,opencode" make docs-review

# Control the final merge/synthesis pass
DOCS_REVIEW_ARGS="--agents claude,codex --synthesizer claude" make docs-review
DOCS_REVIEW_ARGS="--agents claude,codex --synthesizer none" make docs-review

# Save cognition-alignment JSON and keep printing Markdown
DOCS_REVIEW_ARGS="--json-out /tmp/tenet-doc-review.json" make docs-review

# Save both outputs
DOCS_REVIEW_ARGS="--json-out /tmp/tenet-doc-review.json --markdown-out /tmp/tenet-doc-review.md" make docs-review

# Save Markdown without printing it
DOCS_REVIEW_ARGS="--markdown-out /tmp/tenet-doc-review.md --no-print" make docs-review
```

Run the real-agent E2E smoke test with Claude + Codex by default:

```bash
make docs-review-e2e
```

Customize E2E reviewers and the final synthesizer:

```bash
DOCS_REVIEW_E2E_AGENTS=codex make docs-review-e2e
DOCS_REVIEW_E2E_AGENTS=opencode make docs-review-e2e
DOCS_REVIEW_E2E_AGENTS=claude,opencode make docs-review-e2e
DOCS_REVIEW_E2E_AGENTS=claude,codex,opencode make docs-review-e2e
DOCS_REVIEW_E2E_SYNTHESIZER=codex make docs-review-e2e
DOCS_REVIEW_E2E_SYNTHESIZER=none make docs-review-e2e
```

The E2E always runs with `--fail-on never` and only verifies real subprocess plumbing, JSON shape, Markdown output, reviewer metadata, merged issue metadata, and that repo-tracked files did not change. It writes reports to a temp directory by default. To choose an output directory, use a path outside the repository:

```bash
DOCS_REVIEW_E2E_OUTPUT_DIR=/tmp/tenet-doc-review-e2e make docs-review-e2e
DOCS_REVIEW_E2E_PRINT_MARKDOWN=1 make docs-review-e2e
```

## License

MIT
