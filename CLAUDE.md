# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Tenet

Cross-platform AI agent plugin for 12+ hour autonomous development cycles. It orchestrates long-running jobs across multiple AI agent CLIs (Claude Code, OpenCode, Codex) using a persistent SQLite state store, exposed via an MCP server and CLI.

## Build & Development Commands

```bash
pnpm run build          # Compile TypeScript → dist/
pnpm run build:watch    # Watch mode
pnpm run typecheck      # Type-check without emitting
pnpm run lint           # ESLint on src/
pnpm run test           # Run all tests (vitest)
pnpm run test:watch     # Watch mode
pnpm run test:coverage  # Coverage report (v8)
```

Run a single test file:
```bash
npx vitest run src/core/state-store.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "job lifecycle"
```

## Architecture

The system has four layers:

1. **Core** (`src/core/`) — Job orchestration (`job-manager.ts`), SQLite persistence (`state-store.ts`), and status file sync (`status-writer.ts`). JobManager handles DAG-based job execution with heartbeat stall detection, retry logic (`retryJob()`), and configurable concurrency. StateStore manages the `jobs`, `events`, `steer_messages`, and `config` tables in `.tenet/.state/tenet.db` (WAL mode). Status files (`.tenet/status/status.md`, `job-queue.md`) auto-update on every job state transition.

2. **Adapters** (`src/adapters/`) — Pluggable agent adapters that spawn CLI subprocesses. Each adapter implements `AgentAdapter` from `base.ts`: `isAvailable()`, `invoke(invocation)`. Three built-in: `ClaudeAdapter` (`claude --print`), `OpenCodeAdapter` (`opencode run`), `CodexAdapter` (`codex exec`). The adapter registry in `index.ts` resolves agents by name with fallback.

3. **MCP Server** (`src/mcp/`) — Exposes 17 tools via `@modelcontextprotocol/server`. Entry point at `src/mcp/index.ts`. Each tool in `src/mcp/tools/` registers itself with a Zod input schema and handler. Key tools: `tenet_start_job`, `tenet_continue` (server-side continuation), `tenet_compile_context`, `tenet_register_jobs` (loads job DAG, requires `feature` slug), `tenet_retry_job` (resets completed/failed jobs to pending), `tenet_validate_clarity`, `tenet_add_steer` (creates steer messages in SQLite), `tenet_start_eval` (dispatches code critic + test critic).

4. **CLI** (`src/cli/`) — Commander.js program with `init`, `serve`, `status`, `config` commands. `tenet init` scaffolds a `.tenet/` directory structure and copies skill files to `.claude/skills/tenet/`.

## Key Types (`src/types/index.ts`)

- **Job**: id, type (`dev|eval|critic_eval|mechanical_eval|integration_test|compile_context|health_check`), status (`pending|running|completed|failed|cancelled|blocked`), params, agentName
- **SteerMessage**: class (`context|directive|emergency`), status (`received|acknowledged|acted_on|resolved`)
- **ContinuationState**: tracks DAG progress — next_job, blocked_jobs, completed/total counts
- **Config**: agent selection (default, fallback, per-type overrides), concurrency limits

## .tenet/ Document Conventions

Feature-scoped documents use `$date-$feature.md` naming to accumulate across runs:
- `spec/2026-04-08-oauth.md`, `spec/2026-04-15-payments.md`
- `decomposition/2026-04-08-oauth.md` (own directory, not under spec/)
- `interview/2026-04-08-oauth.md`

Project-wide documents stay singular:
- `harness/current.md`, `steer/inbox.md`

Auto-generated from DB:
- `status/status.md`, `status/job-queue.md`

`tenet_compile_context` resolves the latest doc per feature by globbing `*-{feature}.md` and sorting by date prefix. Falls back to old singleton paths (`spec/spec.md`) for backward compatibility.

`tenet_register_jobs` requires a `feature` slug that propagates to all jobs in the DAG.

Dev-type jobs get a "Deliverable Requirements" preamble prepended to their prompt, with extra retry context when `retryCount > 0`.

## Conventions

- ESM throughout (`"type": "module"` in package.json, `NodeNext` module resolution)
- MCP tool pattern: one file per tool in `src/mcp/tools/`, exports a registration function taking the server and dependencies, uses `registerTool()` with Zod schema
- Tests use `MockAdapter` to avoid spawning real agent CLIs
- Tool handlers return `jsonResult({...})` on success or `asToolError(error)` on failure
- The `.tenet/` directory is a per-project artifact created by `tenet init`, not part of this repo's own state

## Planning Docs

Design documents in `docs/planning/` are numbered chronologically. Key docs:
- `02_adverserial_review_improvements.md` — 12 research-based improvements with priority rankings
- `04_implementation_architecture.md` — Architecture decisions and Ouroboros lessons
- `05_test_observations_2026-04-08.md` — 23 observations from manual testing
- `06_status_2026-04-08.md` — Current implementation status and what's remaining
