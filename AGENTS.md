# AGENTS.md

Operational guide for OpenCode sessions working in this repo. Compact by design — verify against source if anything here seems stale.

<!-- BACKLOG.MD GUIDELINES START -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**For every user request in this project, run `backlog instructions overview` before answering or taking action.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Use the detailed guides when needed:
- `backlog instructions task-creation` for creating or splitting tasks
- `backlog instructions task-execution` for planning and implementation workflow
- `backlog instructions task-finalization` for completion and handoff

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->

## What is Tenet

Cross-platform AI agent plugin for 12+ hour autonomous development cycles. It orchestrates long-running jobs across multiple AI agent CLIs (Claude Code, OpenCode, Codex) using a persistent SQLite state store, exposed via an MCP server and CLI.

## Commands

Prefer `make` targets over raw `pnpm` scripts (the Makefile keeps the pre-publish gate and version flow consistent). `make help` lists targets.

- `make check` — pre-publish gate. Order is **clean → build → typecheck → lint → test**. Note build runs *before* typecheck/lint/test (composite build must succeed first); this differs from `.github/workflows/ci.yml`, which runs typecheck → lint → test → build. Run `make check` (or the full sequence) before declaring work done.
- `make test-migrations` — DB migration tests only.
- Single test file: `npx vitest run src/core/state-store.test.ts`
- Tests matching a name pattern: `npx vitest run -t "job lifecycle"`
- `make docs-review` / `make docs-review-e2e` — AI doc/code consistency review; spawns real agent CLIs (costs time/money), repo-maintenance only, not shipped runtime. Flags via `DOCS_REVIEW_ARGS`, e.g. `DOCS_REVIEW_ARGS="--agents claude,codex" make docs-review`.
- E2E canaries: `make e2e-cli|api|web|agile|agile-full|all` — run real agent CLIs, cost money/time, use `vitest.e2e.config.ts`, **not** part of `pnpm test` or `make check`. Run only when explicitly requested. See `docs/e2e-runbook.md`.
- `make link` / `unlink` — global pnpm link for local dev.

## Testing constraints

- **Never spawn real agent CLIs in unit or Tier-1 integration tests.** Use the inline `MockAdapter` (unit) or `FakeAdapter` (`src/adapters/fake-adapter.ts`, Tier-1). Fixtures live in `tests/fixtures/fake-agents/` and are returned verbatim — do not pre-parse them.
- Tier-1 integration tests (`src/core/integration.test.ts`): use the `createHarness` helper + `matchers.*` (not inline predicates), always `await manager.waitForJob(...)`, and assert against DB state — not against your own mock bookkeeping.
- When adding a Tier-1 scenario: drop a fixture under `tests/fixtures/fake-agents/`, name it for intent, write an `it(...)` block, and confirm the test goes red when you break the code path it covers. Rules of thumb live in `tests/README.md`.
- E2E canaries are manual (Tier 2): `make e2e-cli|api|web|agile|agile-full|all`. They cost real money/time; never gate on them.

## Architecture

Four layers under `src/`:

1. **Core** (`src/core/`) — `job-manager.ts` (DAG execution, heartbeat stall detection, retry, orphan recovery), `state-store.ts` (SQLite persistence in `.tenet/.state/tenet.db`, WAL mode), `migrations.ts` (DB schema), `runtime-config.ts` (defaults), `status-writer.ts` (status files). Tables: `jobs`, `events`, `steer_messages`, `config`. Each JobManager instance gets a UUID `serverId`; orphaned running jobs from a stale server are reset to `pending` only after the heartbeat timeout fires (`resetOrphanedJobs()`). Status files (`.tenet/status/status.md`, `job-queue.md`) auto-update on every job state transition.

2. **Adapters** (`src/adapters/`) — `AgentAdapter` interface (`base.ts`): `isAvailable()`, `invoke(invocation)`. Three built-ins: `ClaudeAdapter` (`claude --print --output-format json`), `OpenCodeAdapter` (`opencode run --format json`), `CodexAdapter` (`codex exec --sandbox workspace-write`). `FakeAdapter` for Tier-1 tests. JobManager resolves the configured adapter strictly by name and fails closed if unavailable. Agent selection is CLI-only via `tenet config --agent <name>`.

3. **MCP Server** (`src/mcp/`) — 19 tools via `@modelcontextprotocol/server`, entry `src/mcp/index.ts`, one file per tool in `src/mcp/tools/`. Tools register with a Zod input schema and handler; return `jsonResult({...})` on success or `asToolError(error)` on failure. Key tools: `tenet_start_job`, `tenet_continue` (server-side continuation), `tenet_compile_context` (orchestrator context — not forwarded to worker subprocess), `tenet_register_jobs` (loads job DAG, requires `feature` slug), `tenet_retry_job`, `tenet_report_blocking_finding` (report-only escalation), `tenet_validate_clarity` / `tenet_validate_readiness` (hard gate before decomposition), `tenet_add_steer` / `tenet_process_steer` / `tenet_update_steer`, `tenet_start_eval` (dispatches critics from `.tenet/critics.json` — 3 built-in: code critic + test critic + interaction-e2e, plus any custom), `tenet_init`.

4. **CLI** (`src/cli/`) — Commander.js: `init`, `serve`, `status`, `config`, `db`. `tenet init` scaffolds `.tenet/` and copies skills to `.claude/skills/tenet/` and `.agents/skills/tenet/` with version metadata. `tenet init --upgrade` runs pending DB migrations (`new StateStore(projectPath, { migrate: true })`) and, only with explicit consent (`--migrate-legacy` flag or interactive Y/N; `-y` does *not* auto-migrate), moves legacy doc dirs into `.tenet/archive/legacy-v1/`. It also runs a git-safety check: if `.tenet/.state/tenet.db` or its WAL sidecars are Git-tracked (the main DB-corruption vector), it warns with the exact `git rm --cached` command — detect-only, never auto-untrack. `tenet db check|backup|snapshot|restore-snapshot` provide read-only diagnostics, verified backup, and Git-safe portable snapshots under `.tenet/state-snapshot/`. A "star the repo" nudge (`src/cli/star-nudge.ts`) fires at the end of an interactive `init`/`--upgrade` — CLI-only, never from the autonomous skill boot loop; opt out with `TENET_NO_STAR_NUDGE`.

## Defaults (verify in `src/core/runtime-config.ts` / `job-manager.ts`)

- Job timeout: 120 minutes (`DEFAULT_JOB_TIMEOUT_MINUTES`); configurable via `tenet config --timeout <minutes>`.
- Max retries: unlimited (`DEFAULT_MAX_RETRIES = -1`); finite budget via `tenet config --max-retries <n>` (values `unlimited`/`infinite`/`inf` accepted).
- Heartbeat stall timeout: 30 minutes (`heartbeatTimeoutMs ?? 30 * 60 * 1000`).

## .tenet/ document layout

`tenet init` scaffolds this; legacy top-level artifact dirs only appear via migration (`src/cli/init.ts` → `migrateLegacyDocuments`).

- **Durable doctrine** — `.tenet/project/` (`overview.md`, `architecture.md`, `product.md`, `testing.md`, `design.md`, `design-components/`). Authored by context-bootstrap (brownfield) or post-interview crystallization (greenfield). Normal implementation jobs must **not** edit it. Stays current via the run-end drift review: jobs flag stale doctrine, the run consolidates proposals into `.tenet/runs/<run>/doctrine-proposals.md`, and an authorized `dev` job (`allow_project_doctrine_edits: true`) applies accepted ones.
- **Per-run artifacts** — `.tenet/runs/<run-slug>/` where `<run-slug>` = `YYYY-MM-DD-<feature>`. Holds `interview.md`, `spec.md`, `harness.md`, `scenarios.md`, `decomposition.md`, `doctrine-proposals.md` (append-only), plus `research/`, `journal/`, `visuals/`, and `critics/` (run-scoped custom critics from the Critic Tailoring step in `skills/tenet/phases/02-spec-and-harness.md` § 4.5 — pruned or promoted at run end by the same section's *Run-end critic lifecycle*).
- **Curated knowledge** — `.tenet/knowledge/` (durable facts promoted via `tenet_update_knowledge`).
- **Legacy evidence** — `.tenet/archive/legacy-v1/` (one-time migration target; reference-only).
- **Auto-generated from DB** — `.tenet/status/` (`status.md`, `job-queue.md`).
- **Portable snapshots** — `.tenet/state-snapshot/` (Git-safe, from `tenet db snapshot`).
- **Configurable eval critics** — two scopes, both wired through `.tenet/critics.json`: **global** durable critics at `.tenet/critics/*.md` (hand-authored via `skills/tenet/critics.md`) and **run-scoped** ephemeral critics at `.tenet/runs/<run-slug>/critics/*.md` (generated per run by Critic Tailoring). `critics.json` is the roster, read live by `tenet_start_eval` on every eval; missing/invalid falls back to the 3 built-ins. `prompt_file` resolves project-relative or absolute, so either scope works with no code change.

Current-run document identity flows through `artifact_paths`: `tenet_validate_readiness` validates exact spec/harness/scenarios/interview paths, `tenet_register_jobs` stores those plus `decomposition` (and `run_path`/`run_slug`) on every job, and `tenet_compile_context` reads the stored paths. Feature-only filename lookup is a compatibility fallback (strict dated patterns, not loose `*-{feature}.md`). Dev-type jobs get a "Deliverable Requirements" preamble (with retry context when `retryCount > 0`); every dispatched worker also gets a run-context block on `invocation.context` built from the job's stored `run_path`/`artifact_paths` by the dispatch path in `toInvocation`, not by `tenet_compile_context`.

## Repo-specific gotchas

- **MCP tool registry:** `src/mcp/tools/tool-names.ts` (`TENET_MCP_TOOL_NAMES`) is the single source of truth; a test in `src/mcp/tools/index.ts` asserts it matches actual registrations. To add a tool, add its name there only — `tenet init` reads this list to pre-approve tools in Claude/Codex/OpenCode configs. No other config edits needed. Removing a tool: drop it from the list; stale entries in existing user `.codex/config.toml` are harmless and `--upgrade` does not prune them.
- **DB schema changes belong only in `src/core/migrations.ts`.** Do not put semantic migrations inside normal `StateStore` startup. Normal startup detects incompatible (legacy or newer) schemas and instructs the user to run `tenet init --upgrade`; real migrations run only via `new StateStore(projectPath, { migrate: true })`, wired to that command. The `config.db_schema_version` key tracks schema version.
- **Never commit `.tenet/.state/`** (SQLite DB + WAL sidecars) — it is gitignored, and `tenet init` warns if it is Git-tracked. The root `tenet.db` is a local dev artifact, not source.
- `opencode.json` is generated/gitignored — do not hand-edit expecting it to persist.
- ESM throughout (`"type": "module"`, `NodeNext` module resolution, `strict` TS). Node >= 20, pnpm@10.17.1. ESLint honors the `_`-prefix for intentionally-unused args/vars/caught errors.
- Playwright MCP opt-in must update every supported agent config surface: `.mcp.json` (Claude Code), `.codex/config.toml` (Codex), `opencode.json` (OpenCode).
- `tenet_register_jobs` requires a `feature` slug that propagates to all jobs; pass `artifact_paths` so job context can't drift to stale documents.

## Key types (`src/types/index.ts`)

- **Job**: id, type (`dev|eval|critic_eval|interaction_e2e|mechanical_eval|integration_test|compile_context|health_check`), status (`pending|running|completed|failed|cancelled|blocked|blocked_on_finding`), params, agentName.
- **SteerMessage**: class (`context|directive|emergency`), status (`received|acknowledged|acted_on|resolved`). `tenet_process_steer` returns user steers in full and caps agent steers, so user input can't be crowded out by agent noise.
- **ContinuationState**: tracks DAG progress — next_job, blocked_jobs, completed/total counts.
- **Config**: explicit agent selection (default and per-type overrides), concurrency limits.

## Versioning & release

CalVer `YY.MM.PATCH` (e.g., `26.7.4`): same-month bump via `make bump-patch`, new-month reset via `make bump-month`.

**Never tag, bump, or create a GitHub release without an explicit user request.** Release flow is automated and user-initiated — see `docs/release-runbook.md` for the full runbook including OIDC setup and failure recovery. In short: bump → commit → push → tag with user-facing annotated-tag notes → push tag → `.github/workflows/release.yml` creates a draft release → overwrite the draft notes with the same content → user clicks "Publish release" → `.github/workflows/publish.yml` runs typecheck + lint + test + build + `npm publish --provenance` via OIDC (no manual `npm publish`). PRs/pushes to `main` run `.github/workflows/ci.yml` (typecheck → lint → test → build). Manual `make release` is an emergency fallback only.

## Planning docs

Design documents in `docs/planning/` are numbered chronologically. Key references:
- `04_implementation_architecture.md` — architecture decisions and Ouroboros lessons
- `11_auto_testing_plan.md` — Tier-1 integration test plan

## Layout (entrypoints)

Built entrypoints: `dist/cli/index.js` (`tenet`) and `dist/mcp/index.js` (`tenet-mcp`). Package exports: `.` (root) and `./mcp`. `files` shipped to npm: `dist`, `skills`, `templates`.