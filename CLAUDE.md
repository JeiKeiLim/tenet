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

1. **Core** (`src/core/`) — Job orchestration (`job-manager.ts`) and SQLite persistence (`state-store.ts`). JobManager handles DAG-based job execution with heartbeat stall detection, retry logic, and configurable concurrency. StateStore manages the `jobs`, `events`, `steer_messages`, and `config` tables in `.tenet/.state/tenet.db` (WAL mode).

2. **Adapters** (`src/adapters/`) — Pluggable agent adapters that spawn CLI subprocesses. Each adapter implements `AgentAdapter` from `base.ts`: `isAvailable()`, `invoke(invocation)`. Three built-in: `ClaudeAdapter` (`claude --print`), `OpenCodeAdapter` (`opencode run`), `CodexAdapter` (`codex exec`). The adapter registry in `index.ts` resolves agents by name with fallback.

3. **MCP Server** (`src/mcp/`) — Exposes 15+ tools via `@modelcontextprotocol/server`. Entry point at `src/mcp/index.ts`. Each tool in `src/mcp/tools/` registers itself with a Zod input schema and handler. Key tools: `tenet_start_job`, `tenet_continue` (server-side continuation), `tenet_compile_context`, `tenet_register_jobs` (loads job DAG), `tenet_validate_clarity`.

4. **CLI** (`src/cli/`) — Commander.js program with `init`, `serve`, `status`, `config` commands. `tenet init` scaffolds a `.tenet/` directory structure and copies skill files to `.claude/skills/tenet/`.

## Key Types (`src/types/index.ts`)

- **Job**: id, type (`dev|eval|mechanical_eval|compile_context|health_check`), status (`pending|running|completed|failed|cancelled|blocked`), params, agentName
- **SteerMessage**: class (`context|directive|emergency`), status (`received|acknowledged|acted_on|resolved`)
- **ContinuationState**: tracks DAG progress — next_job, blocked_jobs, completed/total counts
- **Config**: agent selection (default, fallback, per-type overrides), concurrency limits

## Conventions

- ESM throughout (`"type": "module"` in package.json, `NodeNext` module resolution)
- MCP tool pattern: one file per tool in `src/mcp/tools/`, exports a registration function taking the server and dependencies, uses `registerTool()` with Zod schema
- Tests use `MockAdapter` to avoid spawning real agent CLIs
- Tool handlers return `jsonResult({...})` on success or `asToolError(error)` on failure
- The `.tenet/` directory is a per-project artifact created by `tenet init`, not part of this repo's own state
