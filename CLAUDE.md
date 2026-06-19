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
make test-migrations  # Run DB migration tests
make docs-review  # AI doc/code consistency review (Claude by default)
make docs-review-e2e  # Real Claude+Codex subprocess smoke test for docs-review
make check        # clean + build + typecheck + lint + test (pre-publish gate)
make link / unlink  # Global pnpm link for local dev
make bump-patch   # YY.MM.PATCH → YY.MM.PATCH+1
make bump-month   # Reset to current YY.MM.0
make release      # bump-patch + check + npm publish
```

Direct `pnpm` scripts remain available (`pnpm run build`, `pnpm run test:coverage`, etc.) for cases the Makefile doesn't cover.

Doc/code consistency review is repo-maintenance tooling, not shipped Tenet runtime:
- `make docs-review` runs `scripts/docs-review.mjs` against current authoritative docs and code-derived facts. Default reviewer: Claude; default synthesizer: Claude. Use `DOCS_REVIEW_ARGS="--agents claude,codex,opencode --synthesizer claude" make docs-review` for a broader review, or `--synthesizer none` to skip merged-issue synthesis.
- `make docs-review-e2e` runs the same command through real Claude+Codex subprocesses with `--fail-on never` and asserts the repo status is unchanged. It verifies reviewer plumbing, merged issue metadata, and output shape only; it must not apply fixes from AI findings.

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

1. **Core** (`src/core/`) — Job orchestration (`job-manager.ts`), SQLite persistence (`state-store.ts`), DB migrations (`migrations.ts`), runtime defaults (`runtime-config.ts`), and status file sync (`status-writer.ts`). JobManager handles DAG-based job execution with heartbeat stall detection (30-min default heartbeat timeout), retry logic (`retryJob()`), and configurable concurrency. Retry defaults to unlimited (`max_retries = -1` internally); finite budgets are configured with `tenet config --max-retries <n>`. Each JobManager instance generates a UUID (`serverId`) on startup; stale running jobs from a different server instance are reset to "pending" only after their heartbeat exceeds the timeout (orphan detection via `resetOrphanedJobs()`). StateStore manages the `jobs`, `events`, `steer_messages`, and `config` tables in `.tenet/.state/tenet.db` (WAL mode). The `config.db_schema_version` key tracks the DB schema. Normal StateStore startup refuses legacy or newer DB schemas with a clear `tenet init --upgrade` instruction; real migrations only run through `new StateStore(projectPath, { migrate: true })`, which is wired to `tenet init --upgrade`. The `jobs` table includes a `server_id` column for crash recovery tracking. Status files (`.tenet/status/status.md`, `job-queue.md`) auto-update on every job state transition.

2. **Adapters** (`src/adapters/`) — Pluggable agent adapters that spawn CLI subprocesses with a 120-minute default timeout, configurable through `tenet config --timeout <minutes>`. Each adapter implements `AgentAdapter` from `base.ts`: `isAvailable()`, `invoke(invocation)`. Three built-in: `ClaudeAdapter` (`claude --print`), `OpenCodeAdapter` (`opencode run`), `CodexAdapter` (`codex exec --sandbox workspace-write` by default). Global adapter args and job-scoped args (for example `codex_args_playwright_eval`) are read at MCP server startup. JobManager resolves the configured adapter strictly by name and fails closed if that adapter is unavailable.

3. **MCP Server** (`src/mcp/`) — Exposes 18 tools via `@modelcontextprotocol/server`. Entry point at `src/mcp/index.ts`. Each tool in `src/mcp/tools/` registers itself with a Zod input schema and handler. Key tools: `tenet_start_job`, `tenet_continue` (server-side continuation), `tenet_compile_context`, `tenet_register_jobs` (loads job DAG, requires `feature` slug), `tenet_retry_job` (resets completed/failed jobs to pending), `tenet_report_blocking_finding` (report-only escalation), `tenet_validate_clarity`, `tenet_add_steer` (creates steer messages in SQLite), `tenet_start_eval` (dispatches code critic + test critic + playwright eval), `tenet_init` (initialize project from MCP). Agent selection is CLI-only via `tenet config --agent <name>`.

4. **CLI** (`src/cli/`) — Commander.js program with `init`, `serve`, `status`, `config`, and `db` maintenance commands. `tenet init` scaffolds a `.tenet/` directory structure and copies skill files to `.claude/skills/tenet/` and `.agents/skills/tenet/` with generated package-version metadata in each installed `SKILL.md`. `tenet init --upgrade` creates a verified SQLite-safe backup, runs pending DB migrations, then — only with consent — performs the one-time destructive move of legacy document dirs into `.tenet/archive/legacy-v1/`: it prompts Y/N (default No) interactively, or requires the explicit `--migrate-legacy` flag in non-interactive contexts (`-y/--yes` deliberately does not auto-migrate). It then refreshes generated skills/MCP configs. `init`/`--upgrade` also run a "star the repo" nudge (`src/cli/star-nudge.ts`; state per-project in `.tenet/.state/config.json` under `star_nudge`; a decline defers to the next run rather than suppressing permanently; opt out with `TENET_NO_STAR_NUDGE`) at the end of an interactive run — this is CLI-only and never fires from the autonomous skill boot loop. `tenet db check` runs read-only integrity/index diagnostics, `tenet db backup` creates a verified standalone SQLite backup, and `tenet db snapshot`/`restore-snapshot` write and restore Git-safe portable snapshots under `.tenet/state-snapshot/`.

## Key Types (`src/types/index.ts`)

- **Job**: id, type (`dev|eval|critic_eval|playwright_eval|mechanical_eval|integration_test|compile_context|health_check`), status (`pending|running|completed|failed|cancelled|blocked|blocked_on_finding`), params, agentName
- **SteerMessage**: class (`context|directive|emergency`), status (`received|acknowledged|acted_on|resolved`)
- **ContinuationState**: tracks DAG progress — next_job, blocked_jobs, completed/total counts
- **Config**: explicit agent selection (default and per-type overrides), concurrency limits

## .tenet/ Document Conventions

Tenet uses a document lifecycle layout. `tenet init` scaffolds only this layout; legacy top-level artifact directories only appear via migration (see `src/cli/init.ts` → `migrateLegacyDocuments`).

- **Durable doctrine** — `.tenet/project/` (`overview.md`, `architecture.md`, `product.md`, `testing.md`, `design.md`, `design-components/`). Authored by the context-bootstrap phase (brownfield) or post-interview crystallization (greenfield); normal implementation jobs must not edit it.
- **Per-run artifacts** — `.tenet/runs/<run-slug>/` where `<run-slug>` = `YYYY-MM-DD-<feature>`. Holds `interview.md`, `spec.md`, `harness.md`, `scenarios.md`, `decomposition.md`, plus `research/`, `journal/`, and `visuals/` subdirs.
- **Curated knowledge** — `.tenet/knowledge/` (durable, concern-oriented facts promoted via `tenet_update_knowledge`).
- **Legacy evidence** — `.tenet/archive/legacy-v1/` (one-time migration target for pre-lifecycle top-level dirs: `spec/`, `interview/`, `harness/`, `decomposition/`, `journal/`, `visuals/`, `bootstrap/`, `steer/`, `knowledge/`, `DESIGN.md`). Reference-only, not active doctrine.
- **Auto-generated from DB** — `.tenet/status/` (`status.md`, `job-queue.md`).
- **Portable snapshots** — `.tenet/state-snapshot/` (Git-safe snapshots from `tenet db snapshot`).

Current-run document identity flows through `artifact_paths`: `tenet_validate_readiness` validates exact spec/harness/scenarios/interview paths, `tenet_register_jobs` stores those plus `decomposition` (and `run_path`/`run_slug`) on every job, and `tenet_compile_context` reads the stored paths. Feature-only filename lookup is a compatibility fallback only; it uses strict dated document patterns rather than loose `*-{feature}.md` matching.

`tenet_register_jobs` requires a `feature` slug that propagates to all jobs in the DAG, and current runs should also pass `artifact_paths` so job context cannot drift to stale documents.

Dev-type jobs get a "Deliverable Requirements" preamble prepended to their prompt, with extra retry context when `retryCount > 0`.

## Conventions

- ESM throughout (`"type": "module"` in package.json, `NodeNext` module resolution)
- MCP tool pattern: one file per tool in `src/mcp/tools/`, exports a registration function taking the server and dependencies, uses `registerTool()` with Zod schema
- Tests use non-spawning test doubles to avoid real agent CLIs: inline `MockAdapter` for unit tests and `FakeAdapter` (`src/adapters/fake-adapter.ts`) for the Tier-1 integration harness
- Tool handlers return `jsonResult({...})` on success or `asToolError(error)` on failure
- The `.tenet/` directory is a per-project artifact created by `tenet init`, not part of this repo's own state
- DB schema changes belong in `src/core/migrations.ts`. Do not hide semantic migrations inside normal `StateStore` startup; normal startup should detect incompatibility and tell the user to close the agent, run `tenet init --upgrade`, and restart.

## MCP Tool Pre-Approval (agent configs)

When adding or removing an MCP tool, three pre-approval configs must stay in sync:

1. **Tool name list** — `src/mcp/tools/tool-names.ts` (`TENET_MCP_TOOL_NAMES`). This is the single source of truth. A test in `src/mcp/tools/index.ts` asserts this list matches actual registrations.

2. **Claude Code** — `src/cli/init.ts` → `mergeClaudeLocalSettings()`. Reads `TENET_MCP_TOOL_NAMES` and writes `mcp__tenet__<name>` entries to `.claude/settings.local.json`. No manual update needed — it reads from the tool-names list.

3. **Codex** — `src/cli/init.ts` → `writeCodexConfig()`. Reads `TENET_MCP_TOOL_NAMES` and writes per-tool `[mcp_servers.tenet.tools.<name>] approval_mode = "approve"` sections to `.codex/config.toml`. No manual update needed — it reads from the tool-names list.

4. **OpenCode** — `src/cli/init.ts` → `mergeOpenCodePermission()`. Writes `permission.mcp.tenet: "allow"` to `opencode.json`. Playwright opt-in also writes `permission.mcp.playwright: "allow"` and the Playwright MCP entry. No per-tool config needed — OpenCode approves at server level.

Playwright MCP opt-in must update every supported agent config surface: `.mcp.json` for Claude Code, `.codex/config.toml` for Codex, and `opencode.json` for OpenCode.

**When adding a new MCP tool:** Add the name to `TENET_MCP_TOOL_NAMES` in `tool-names.ts`. The init functions read this list automatically — no other config changes needed.

**When removing an MCP tool:** Remove from `TENET_MCP_TOOL_NAMES` in `tool-names.ts`. Existing `.codex/config.toml` files in user projects will still have the stale entry but it's harmless. The `tenet init --upgrade` path will add missing tools but does not prune stale ones.

## Versioning

Uses **CalVer** (`YY.MM.PATCH`): e.g., `26.4.0` is the first release in April 2026, `26.4.1` is the second. New month resets patch to 0. This communicates freshness in a fast-moving AI tooling space while staying npm-compatible.

**Release flow (automated — only when the user explicitly requests a new version):**

1. Bump via `make bump-patch` (same month) or `make bump-month` (new month).
2. Commit the `package.json` change with message `chore: bump to YY.MM.PATCH`.
3. Push the commit: `git push origin main`.
4. Write user-facing release notes first, then use them as the **annotated tag message**. Do not create placeholder tag messages like `"Release vYY.MM.PATCH"`. The tag body should include the same sections intended for the draft GitHub Release: Highlights, Changes, Breaking changes, and Full changelog. Create the tag with those notes, e.g. `git tag -a vYY.MM.PATCH -F /tmp/tenet-release-vYY.MM.PATCH.md`, then `git push origin vYY.MM.PATCH`.
5. Wait for `.github/workflows/release.yml` to create a **draft** release on GitHub (automatic, ~30s).
6. **Overwrite the auto-generated draft with the same release notes used in the annotated tag.** The workflow seeds the draft with `gh --generate-notes` (a raw commit list); that's not a release note. Replace it:
   ```bash
   gh release edit vYY.MM.PATCH --notes "$(cat <<'EOF'
   ## Highlights
   - <user-facing summary of the main change>
   - <another highlight>

   ## Changes
   - <bullet per meaningful commit or planning-doc section>

   ## Breaking changes
   <none | describe>

   ## Full changelog
   https://github.com/JeiKeiLim/tenet/compare/vPREV...vYY.MM.PATCH
   EOF
   )"
   ```
   Write notes in user-facing language (what changed for the user, not what files moved). Pull structure from any planning doc that motivated the release; skip mechanical commits like `chore: bump`.
7. Tell the user: "Draft release created with notes at https://github.com/JeiKeiLim/tenet/releases/tag/vYY.MM.PATCH. Review and click 'Publish release' to trigger npm publishing."

The user clicking "Publish release" fires `.github/workflows/publish.yml`, which runs typecheck + tests + build + `npm publish --provenance` via OIDC. No manual `npm publish` needed.

Manual fallback (for automation outages only): `make release` still works locally if the maintainer has `npm login`.

Never tag or create a GitHub release without an explicit user request — version bumps are always user-initiated. See `docs/release-runbook.md` for the full runbook including OIDC setup and failure recovery.

## Planning Docs

Design documents in `docs/planning/` are numbered chronologically. Key docs:
- `02_adverserial_review_improvements.md` — 12 research-based improvements with priority rankings
- `04_implementation_architecture.md` — Architecture decisions and Ouroboros lessons
- `05_test_observations_2026-04-08.md` — 23 observations from manual testing
- `06_status_2026-04-08.md` — Current implementation status and what's remaining
- `07_round5_fixes_2026-04-14.md` — 6 issues from round 5 testing (timeout, stall recovery, playwright, wiring)
