# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Tenet

Cross-platform AI agent plugin for 12+ hour autonomous development cycles. It orchestrates long-running jobs across multiple AI agent CLIs (Claude Code, OpenCode, Codex) using a persistent SQLite state store, exposed via an MCP server and CLI.

## Build & Development Commands

A `Makefile` wraps the common `pnpm` scripts — prefer it for regular workflows so the pre-publish gate and version bump stay consistent. Run `make help` to list targets.

```bash
make build        # Compile TypeScript → dist/
make dev          # Watch mode (build:watch)
make typecheck    # Type-check without emitting
make lint         # ESLint on src/
make test         # Run all tests (vitest)
make check        # clean + build + typecheck + lint + test (pre-publish gate)
make link / unlink  # Global pnpm link for local dev
make bump-patch   # YY.MM.PATCH → YY.MM.PATCH+1
make bump-month   # Reset to current YY.MM.0
make release      # bump-patch + check + npm publish
```

Direct `pnpm` scripts remain available (`pnpm run build`, `pnpm run test:coverage`, etc.) for cases the Makefile doesn't cover.

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

1. **Core** (`src/core/`) — Job orchestration (`job-manager.ts`), SQLite persistence (`state-store.ts`), and status file sync (`status-writer.ts`). JobManager handles DAG-based job execution with heartbeat stall detection (30-min default timeout), retry logic (`retryJob()`), and configurable concurrency. Each JobManager instance generates a UUID (`serverId`) on startup; running jobs from a different server instance are automatically reset to "pending" (orphan detection via `resetOrphanedJobs()`). StateStore manages the `jobs`, `events`, `steer_messages`, and `config` tables in `.tenet/.state/tenet.db` (WAL mode). The `jobs` table includes a `server_id` column for crash recovery tracking. Status files (`.tenet/status/status.md`, `job-queue.md`) auto-update on every job state transition.

2. **Adapters** (`src/adapters/`) — Pluggable agent adapters that spawn CLI subprocesses. Each adapter implements `AgentAdapter` from `base.ts`: `isAvailable()`, `invoke(invocation)`. Three built-in: `ClaudeAdapter` (`claude --print`), `OpenCodeAdapter` (`opencode run`), `CodexAdapter` (`codex exec`). The adapter registry in `index.ts` resolves agents by name with fallback.

3. **MCP Server** (`src/mcp/`) — Exposes 17 tools via `@modelcontextprotocol/server`. Entry point at `src/mcp/index.ts`. Each tool in `src/mcp/tools/` registers itself with a Zod input schema and handler. Key tools: `tenet_start_job`, `tenet_continue` (server-side continuation), `tenet_compile_context`, `tenet_register_jobs` (loads job DAG, requires `feature` slug), `tenet_retry_job` (resets completed/failed jobs to pending), `tenet_validate_clarity`, `tenet_add_steer` (creates steer messages in SQLite), `tenet_start_eval` (dispatches code critic + test critic + playwright eval), `tenet_init` (initialize project from MCP), `tenet_set_agent` (switch default agent).

4. **CLI** (`src/cli/`) — Commander.js program with `init`, `serve`, `status`, `config` commands. `tenet init` scaffolds a `.tenet/` directory structure and copies skill files to `.claude/skills/tenet/`.

## Key Types (`src/types/index.ts`)

- **Job**: id, type (`dev|eval|critic_eval|playwright_eval|mechanical_eval|integration_test|compile_context|health_check`), status (`pending|running|completed|failed|cancelled|blocked`), params, agentName
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

## Versioning

Uses **CalVer** (`YY.MM.PATCH`): e.g., `26.4.0` is the first release in April 2026, `26.4.1` is the second. New month resets patch to 0. This communicates freshness in a fast-moving AI tooling space while staying npm-compatible.

**Release flow (automated — only when the user explicitly requests a new version):**

1. Bump via `make bump-patch` (same month) or `make bump-month` (new month).
2. Commit the `package.json` change with message `chore: bump to YY.MM.PATCH`.
3. Push the commit: `git push origin main`.
4. Tag the commit: `git tag -a vYY.MM.PATCH -m "..."` then `git push origin vYY.MM.PATCH`.
5. Wait for `.github/workflows/release.yml` to create a **draft** release on GitHub (automatic, ~30s).
6. Tell the user: "Draft release created at https://github.com/JeiKeiLim/tenet/releases. Review the notes and click 'Publish release' to trigger npm publishing."

The user clicking "Publish release" fires `.github/workflows/publish.yml`, which runs typecheck + tests + `npm publish --provenance` via OIDC. No manual `npm publish` needed.

Manual fallback (for automation outages only): `make release` still works locally if the maintainer has `npm login`.

Never tag or create a GitHub release without an explicit user request — version bumps are always user-initiated. See `docs/release-runbook.md` for the full runbook including OIDC setup and failure recovery.

## Planning Docs

Design documents in `docs/planning/` are numbered chronologically. Key docs:
- `02_adverserial_review_improvements.md` — 12 research-based improvements with priority rankings
- `04_implementation_architecture.md` — Architecture decisions and Ouroboros lessons
- `05_test_observations_2026-04-08.md` — 23 observations from manual testing
- `06_status_2026-04-08.md` — Current implementation status and what's remaining
- `07_round5_fixes_2026-04-14.md` — 6 issues from round 5 testing (timeout, stall recovery, playwright, wiring)
