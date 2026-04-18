# 10 — Readiness-Decided Eval Mode + Report-Only Remediation

**Created**: 2026-04-17
**Status**: Design
**Origin**: `tenet-manual-test-codex` 10-hour autonomous run retrospective (`TENET_PIPELINE_RETROSPECTIVE.md`, 2026-04-16)

---

## Motivation

The Codex run completed successfully (266 jobs, all gates green) but burned ~90 evaluation cycles and produced 40+ failure journals fighting orchestration hygiene rather than coding problems. Two distinct failure modes accounted for most of the wasted work:

### Failure mode A — Concurrent eval contention

Three critic jobs (`code_critic`, `test_critic`, `playwright_eval`) run in parallel. Each may execute heavy commands like `npm test`, `npx playwright test`, or `npm run test:acceptance`. In stateful projects, those commands shared:

- the same SQLite DB (`prisma/dev.db`)
- the same auth/session/rate-limit rows
- the same server lifecycle and port
- the same Playwright lock directory

This produced false failures that looked like product bugs (`429` before the boundary, FK violations, moderation state mismatches, "stale" lock files) but were actually contention artifacts. Critics then asked the implementing agent to fix imaginary bugs, triggering further cycles.

### Failure mode B — Report-only scope vs. necessary remediation

A "report-only" job (`e2e-3`) discovered real harness instability while writing its final acceptance report. The user had instructed "never stop, continue autonomously," so the agent edited harness files. The code critic correctly failed the job for violating its declared scope. **Both sides were correct under the current rulebook** — the missing primitive was a way for a report-only job to spawn a remediation child job without scope-violating itself.

## What This Is NOT

Scaled back from the retrospective's full menu:

- **No resource isolation contract.** No `TENET_TMPDIR` / `TENET_PORT_BASE` / per-eval temp DB injection. Concluded over-engineered for the general case — many project types (libraries, CLIs, data pipelines) need none of it.
- **No structured verification ledger.** Markdown reports stay the source of truth.
- **No runtime artifact ownership registry.** Both the ledger and the registry exist mainly to coordinate parallel evals; if parallelism is opt-in by readiness verdict, the contention problem is resolved upstream.
- **No harness determinism gate.** Folded into the readiness verdict — if tests are demonstrably flaky, the readiness rubric will flag the test strategy as `partial`/`blocked`.

## Design

### Part 1 — Readiness gate decides eval execution mode

Extend `tenet_validate_readiness` to answer one additional question:

> **Eval execution mode** — Do this feature's tests share mutable state (DB rows, sessions, rate limits, ports, files, processes)? If yes, parallel critics will collide; if no, parallel evals are safe.

The rubric output gains two fields:

```json
{
  "passed": true,
  "categories": { ... },
  "eval_parallel_safe": false,
  "eval_parallel_rationale": "Tests share Prisma SQLite + rate-limit rows + auth sessions; parallel critics would collide.",
  ...
}
```

#### Persistence

When the readiness job completes, `tenet_validate_readiness` writes the verdict to the `config` table keyed by feature:

```
eval_parallel_safe:{feature} = "true" | "false"
```

This survives across server restarts and is queryable by other tools.

#### Consumption

`tenet_start_eval` reads the per-feature verdict at dispatch time:

- `parallel_safe = true` → dispatch the 3 critic jobs in parallel (today's behavior).
- `parallel_safe = false` → chain the 3 critic jobs via `depends_on` so they run sequentially. Code critic finishes → test critic starts → playwright eval starts.
- Verdict missing (e.g. quick mode, no readiness gate ran) → default to **sequential** (safe fallback).

#### Override

User can override via steer:

```
tenet_add_steer(content="set eval_parallel_safe=true for {feature}", class="directive")
```

Orchestrator interprets the directive, writes to the config table directly.

#### Why this shape

- **Decision lands at the right time.** Readiness already reads spec, harness, and test strategy — it has every signal needed to judge "do these tests step on each other?"
- **No static default that's wrong half the time.** Pure libraries / CLIs stay fast (parallel); stateful web apps stay correct (sequential).
- **No new env-var contract for projects to learn.** Zero project-side change required.
- **Reuses just-shipped infrastructure.** The readiness gate (commit `38bb2a4`) is already a hard block before decomposition; this is an additive question.

### Part 2 — Report-only escape hatch

Introduce a structured way for a `report_only` job to request remediation without violating its own scope.

#### Job param

Jobs can be tagged in their params:

```typescript
{
  name: "Final acceptance sweep",
  prompt: "...",
  report_only: true
}
```

`tenet_register_jobs` accepts the flag and persists it. `tenet_compile_context` reads it and emits a preamble when set:

> ## Report-Only Scope
>
> You are in report-only mode. You MUST NOT edit project files (other than writing your final report).
>
> If verification reveals a real bug that must be fixed for this report to be trustworthy:
>
> 1. Call `tenet_request_remediation({reason, suggested_fix, target_files})`.
> 2. Your job will be paused (`blocked_remediation_required`).
> 3. A child `dev` job will fix the issue and pass its own evals.
> 4. Your job will auto-resume with fresh context once the fix lands.
>
> Do NOT edit files yourself. Do NOT silently work around the bug. Do NOT abandon the report.

#### New MCP tool — `tenet_request_remediation`

Inputs:
- `reason: string` — why remediation is needed
- `suggested_fix: string` — what the child job should do
- `target_files: string[]` (optional) — hint for the child job's scope

Behavior:
1. Marks the calling job's status as `blocked_remediation_required`.
2. Spawns a child `dev` job with `parent_job_id` = caller, prompt derived from `reason + suggested_fix + target_files`.
3. Returns immediately so the report agent can cleanly end its turn.

#### New job status — `blocked_remediation_required`

Added to `JobStatus` union. Treated like `blocked` for queue purposes (not picked by `tenet_continue` while waiting), but distinct so the orchestrator and `tenet_get_status` can show *why* it's blocked.

#### Auto-resume

`job-manager.ts` watches for child job completion. When a child dev job with a `parent_job_id` completes successfully **and passes its eval**:

1. Parent job (currently `blocked_remediation_required`) flips to `pending`.
2. `retryCount` does not increment — this isn't a retry, it's a resume after dependency.
3. Parent gets re-dispatched via the normal `tenet_continue` flow with fresh context (so it sees the post-fix state).

If the child fails its eval (max retries exhausted), parent stays blocked and surfaces to the user.

### Part 3 — Two small P2 items

#### 3a. Visual eval honesty

`playwright_eval` worker prompt currently says: *"If Playwright MCP is not available, report 'Playwright MCP not installed — exploratory testing skipped' and pass with Layer 1 results."*

Today the pass result doesn't preserve that distinction. Update the worker output schema to surface it explicitly:

```json
{
  "passed": true,
  "stage": "playwright_eval",
  "layer1_results": "...",
  "layer2_status": "completed" | "skipped_no_mcp" | "failed",
  "exploratory_findings": [...]
}
```

`tenet_get_status` and any final report aggregation should display `layer2_status` rather than treating "passed" as equivalent to "fully verified."

#### 3b. Failure classification

Critic prompts currently produce `findings: ["..."]` as free-form strings. Add a required `category` per finding:

```json
{
  "passed": false,
  "findings": [
    { "category": "product_bug", "detail": "Login redirects to /login instead of /dashboard" },
    { "category": "test_bug", "detail": "Test asserts page does NOT have /error, passes even when login fails" },
    { "category": "harness_bug", "detail": "Acceptance suite leaves SQLite locked after Ctrl+C" },
    { "category": "evidence_mismatch", "detail": "Report claims 64 tests pass, fresh run shows 63" },
    { "category": "contention", "detail": "Rate limit exceeded — likely sibling eval consumed quota" },
    { "category": "scope_conflict", "detail": "Job declared report-only but workspace has edits" }
  ]
}
```

Categories enable smarter routing in the orchestrator:
- `product_bug` → retry the source job
- `test_bug` → spawn test fix job (existing flow)
- `harness_bug` → spawn `harness_fix` job (could be new type, or `dev` with a flag)
- `evidence_mismatch` → re-run the source job's verification commands and refresh the report
- `contention` → re-run the failing eval *after* sibling evals complete (or after switching to sequential)
- `scope_conflict` → trigger the remediation escape hatch (Part 2)

The orchestrator skill (`05-execution-loop.md`) gets a small dispatch table for these categories.

## What Changes — Concrete File List

### Part 1 — Readiness decides eval mode

- `src/mcp/tools/tenet-validate-readiness.ts` — extend rubric prompt; on completion (in a result handler), persist `eval_parallel_safe:{feature}` to `state-store` config.
- `src/core/state-store.ts` — already has a generic `config` key/value table; no schema change needed.
- `src/mcp/tools/tenet-start-eval.ts` — accept optional `feature` param; read `eval_parallel_safe:{feature}` from config; if `false` or missing, set `depends_on` chain across the 3 critic jobs.
- `src/types/index.ts` — no change (job params already free-form).
- `skills/tenet/phases/02-spec-and-harness.md` — note that readiness now also decides eval mode.
- `skills/tenet/phases/06-evaluation.md` — note that the 3 critics may run sequentially or parallel based on readiness verdict.

### Part 2 — Report-only escape hatch

- `src/types/index.ts` — add `'blocked_remediation_required'` to `JobStatus`.
- `src/core/state-store.ts` — accept new status in any enum-validating code (likely none; status is stored as TEXT).
- `src/mcp/tools/tenet-request-remediation.ts` — **new file**, ~60 lines.
- `src/mcp/tools/tenet-compile-context.ts` — add ~20-line preamble emission when `params.report_only === true`.
- `src/mcp/tools/index.ts` — register the new tool.
- `src/core/job-manager.ts` — in the job-completion path, check if the completed job has a `parentJobId` and the parent is `blocked_remediation_required`; if so and the child's eval passed, flip parent to `pending`.
- `skills/tenet/SKILL.md` — add `tenet_request_remediation` to `allowed-tools`.
- `skills/tenet/phases/05-execution-loop.md` — document the report-only protocol and how to mark a job report-only.

### Part 3 — P2 items

- `src/mcp/tools/tenet-start-eval.ts` — extend the playwright eval preamble to require `layer2_status` field; extend code/test critic preambles to require `category` per finding.
- `src/mcp/tools/tenet-get-status.ts` (or wherever final report aggregation lives) — surface `layer2_status` distinctly.
- `skills/tenet/phases/06-evaluation.md` — document the new finding categories and the `layer2_status` field.
- `skills/tenet/phases/05-execution-loop.md` — document the orchestrator's category → action dispatch table.

## Tests

- `src/mcp/tools/tenet-validate-readiness.test.ts` — extend to assert that the rubric output contains `eval_parallel_safe` and that the verdict is persisted to config.
- `src/mcp/tools/tenet-start-eval.test.ts` — **new** (or extend if exists) — assert that with `eval_parallel_safe=false` for a feature, the 3 critic jobs are chained via `depends_on`; with `true`, they have no inter-dependencies.
- `src/mcp/tools/tenet-request-remediation.test.ts` — **new** — assert that calling the tool flips the parent job to `blocked_remediation_required`, spawns a child dev job with `parent_job_id` set, and that subsequent child completion + eval pass auto-resumes the parent.
- `src/core/job-manager.test.ts` — extend with the auto-resume case.

## Migration / Backward Compatibility

- `eval_parallel_safe` verdict is missing for features whose readiness gate ran before this change → defaults to **sequential** (safe). No DB migration needed; the absence of the key *is* the default.
- `JobStatus` adding `'blocked_remediation_required'` is additive; existing jobs unaffected.
- `report_only` flag is opt-in; jobs without it behave exactly as today.
- New finding `category` field is opt-in for first release — old critics returning string-only findings still parse, but lose category routing benefits. Make required in a follow-up after critic prompts have shipped.

## Part 4 — Adapter extra-args passthrough

**Origin:** OpenCode user reported that `opencode run` (subprocess) picked an Anthropic model as its default even though the user's only available model was `github-copilot/claude-opus-4-5`. Interactive `opencode` honored the user's config; the subprocess path did not. Same class of issue is suspected for Codex sandbox-mode divergence (noted in `project_tenet_open_ideas.md`) and Codex timeout flag passthrough.

### Design

Each adapter gains an optional `extraArgs: string[]` constructor parameter. When set, the adapter appends those tokens to its spawned command *before* the prompt/position-dependent args.

```
opencode run <prompt> --format json --dir <workdir>
```

becomes, when `opencode.extra_args = "--model github-copilot/claude-opus-4-5"`:

```
opencode --model github-copilot/claude-opus-4-5 run <prompt> --format json --dir <workdir>
```

(Flag position matters per CLI; each adapter inserts its extra args at the known-safe slot for that CLI — verified via each CLI's `--help` when implementing.)

### CLI

Extend `tenet config` in `src/cli/index.ts`:

```
tenet config --opencode-args "--model github-copilot/claude-opus-4-5"
tenet config --codex-args "--approval-mode never"
tenet config --claude-args "--allowed-tools Bash,Read,Write"
```

Stored in `.tenet/.state/config.json` as `opencode_args`, `codex_args`, `claude_args` (string).

The existing no-flag summary block expands to print these values alongside the others.

### Persistence & load path

- `readStateConfig` already reads arbitrary JSON keys (no schema lock); add typed accessors for `opencode_args`, `codex_args`, `claude_args`.
- `AdapterRegistry` (or wherever adapters are instantiated — see `src/adapters/index.ts`) reads the config at server startup and passes `extraArgs` to each adapter constructor, splitting the string on whitespace (shell-safe parse; document that users cannot embed spaces inside single args via this mechanism — if we ever need that, switch to JSON array storage).

### What changes

- `src/adapters/base.ts` — no change; `extraArgs` is constructor-scoped, not per-invocation.
- `src/adapters/opencode-adapter.ts` — constructor `(timeoutMs, extraArgs: string[] = [])`; insert `...extraArgs` into `args` before `'run'`.
- `src/adapters/codex-adapter.ts` — same pattern.
- `src/adapters/claude-adapter.ts` — same pattern.
- `src/adapters/index.ts` — read config, pass `extraArgs` to each adapter's constructor.
- `src/cli/index.ts` — three new flags, summary print update.
- Tests: extend `src/adapters/adapter.test.ts` to assert each adapter appends extraArgs correctly.

### tenet-diagnose skill update

Add a new section to `skills/tenet-diagnose/SKILL.md`:

> ### 11. Adapter picking the wrong model / wrong behavior
>
> If an agent CLI works interactively but fails when invoked by Tenet as a subprocess, it's almost always because the subprocess sees a different default (model, auth profile, sandbox mode) than your interactive session.
>
> Common symptom: `opencode` works for you manually, but Tenet-spawned opencode jobs fail with "model not available" or similar auth errors — because `opencode run` picked a built-in default model, not the one in your config.
>
> Diagnose:
>
> ```bash
> # See what adapter args Tenet is passing
> cat .tenet/.state/config.json | grep -E "opencode_args|codex_args|claude_args"
>
> # See what the CLI thinks its default is
> opencode --help | head -30
> codex --help | head -30
> ```
>
> Fix by pinning the flag Tenet should inject:
>
> ```bash
> tenet config --opencode-args "--model github-copilot/claude-opus-4-5"
> tenet config --codex-args "--approval-mode never"
> tenet config --claude-args "--allowed-tools Bash,Read,Write,Edit"
> ```
>
> Restart the Tenet MCP server after changing adapter args.

No separate "help" skill is created for this — diagnose is the closest fit and has room.

### Default values

None. `extra_args` is empty by default; today's behavior is preserved for existing users. Only users who hit a divergence problem need to set it.

### Risks

- Argument-splitting on whitespace is naive; a value containing spaces (e.g. `--tool "Bash with space"`) breaks. Acceptable for v1 — document it. If it becomes a problem, switch storage to a JSON array (`"opencode_args": ["--model", "github-copilot/claude-opus-4-5"]`).
- CLI flag position varies between CLIs; adapters must know where to insert. Verified per-adapter; tests cover the exact argv shape.

## Part 5 — Pre-approve Tenet MCP tools during `tenet init`

**Origin:** On a fresh `tenet init`, every first invocation of every Tenet MCP tool triggers an approval prompt in the host agent (Claude Code, OpenCode, or Codex). Since Tenet has 17 MCP tools, this is 17 prompts per agent switch. Previously listed as a Round-3 open idea in `project_tenet_open_ideas.md`; promoting here.

### Problem

`tenet init` today writes three files to wire up MCP **server discovery** — `.mcp.json`, `opencode.json`, `.codex/config.toml`. It writes **zero** files to pre-approve the MCP tools those servers expose. So discovery works, but every tool call prompts.

### Design (per agent)

#### 5a — Claude Code: `.claude/settings.local.json`

Write to `settings.local.json` (gitignored, user-local) — never to `settings.json` (checked into the team repo; tainting it is risky).

Content added:
```json
{
  "permissions": {
    "allow": [
      "mcp__tenet__tenet_init",
      "mcp__tenet__tenet_continue",
      "mcp__tenet__tenet_compile_context",
      "mcp__tenet__tenet_start_job",
      "mcp__tenet__tenet_register_jobs",
      "mcp__tenet__tenet_job_wait",
      "mcp__tenet__tenet_job_result",
      "mcp__tenet__tenet_cancel_job",
      "mcp__tenet__tenet_start_eval",
      "mcp__tenet__tenet_validate_clarity",
      "mcp__tenet__tenet_validate_readiness",
      "mcp__tenet__tenet_update_knowledge",
      "mcp__tenet__tenet_add_steer",
      "mcp__tenet__tenet_process_steer",
      "mcp__tenet__tenet_health_check",
      "mcp__tenet__tenet_get_status",
      "mcp__tenet__tenet_retry_job",
      "mcp__tenet__tenet_request_remediation"
    ]
  },
  "enabledMcpjsonServers": ["tenet"]
}
```

Merge rules:
- If file missing → create with the above.
- If file present → merge additively: append missing entries to `permissions.allow[]` (dedupe); add `"tenet"` to `enabledMcpjsonServers[]` if absent; never remove or modify existing entries.
- If JSON is invalid → skip with warning; user can fix and re-run `tenet init --upgrade`.

Tool list is derived from `src/mcp/tools/index.ts` at build time (or hardcoded and kept in sync by test — prefer derived so new tools auto-register).

#### 5b — OpenCode: `opencode.json`

Add under existing `permission` key:
```json
{
  "mcp": { "tenet": { "*": "allow" } },
  "permission": {
    "mcp": { "tenet": "allow" }
  }
}
```

The second block is the one that matters — `permission.mcp.tenet: "allow"` auto-approves all tools from the Tenet MCP server. Merge additively with existing `permission` keys; never overwrite.

#### 5c — Codex: `.codex/config.toml`

Use **project-scoped trust** (not global approval_policy — that nukes codex's safety for unrelated work).

Append:
```toml
[projects."/absolute/path/to/this/project"]
trust_level = "trusted"
```

Merge rules:
- If `[projects."<this-path>"]` block missing → append.
- If present with `trust_level = "trusted"` → skip.
- If present with `trust_level = "untrusted"` → do NOT silently overwrite; warn the user and let them change it manually. Respecting explicit user choice matters here.

The absolute path must be resolved from `projectPath` argument via `path.resolve`. On macOS, symlink realpath should be applied so the trust entry matches the same path codex uses internally.

### Interactive prompt flow

During `tenet init` (after MCP server config is written), ask **once** per file that would change:

```
Pre-approve Tenet MCP tools for Claude Code?
  - Adds tool names to .claude/settings.local.json (local, not committed)
  - Prevents approval prompts on first use of each Tenet MCP tool
  [Y/n]:

Pre-approve Tenet MCP tools for OpenCode?
  - Adds "permission.mcp.tenet: allow" to opencode.json
  [Y/n]:

Mark this project as trusted in Codex?
  - Adds [projects."<abs-path>"] trust_level = "trusted" to .codex/config.toml
  - Scoped to this project only — unrelated Codex usage is unaffected
  [Y/n]:
```

Defaults:
- Claude Code: **Y** (writes to `.local.json`, fully reversible, affects only this user).
- OpenCode: **Y** (opencode.json is already touched by init).
- Codex: **Y** (project-scoped trust, not global).

All three prompts can be skipped in non-interactive mode (e.g., CI invocations of `tenet init --yes`). A `--yes` / `--assume-yes` flag on `tenet init` is worth adding for this.

### `--upgrade` behavior

Re-run the same additive merges. This ensures:
- New Tenet MCP tools added in a newer version are pre-approved automatically.
- Users who skipped approval on first init can opt in later by running `tenet init --upgrade` (re-prompts).
- Never removes entries, even if they became obsolete — preserves user modifications.

### What changes

- `src/cli/init.ts`:
  - New helper `mergeClaudeSettings(projectPath)` — writes `.claude/settings.local.json` additively.
  - Extend `mergeOpenCodeConfig(projectPath)` — add `permission.mcp.tenet` block.
  - Extend `writeCodexConfig(projectPath)` — append `[projects."<abs-path>"] trust_level = "trusted"`.
  - New helper to derive MCP tool list at runtime (import from `src/mcp/tools/index.ts`) or expose a const `TENET_MCP_TOOL_NAMES`.
  - Three new interactive prompts between the existing init steps. Respect `--yes`.
- `src/cli/index.ts`:
  - Add `--yes` flag to `init` subcommand.
- Tests:
  - `src/cli/init.test.ts` — extend with all three merge paths: create-new / merge-existing / skip-when-already-present / respect-untrusted-codex / respect-invalid-json.

### Caveats

- OpenCode `permission.mcp.tenet` syntax comes from docs dated 2026; confirm against the opencode version the user has. If the schema differs, fall back to global `"*": "allow"` under `permission.mcp` or document a manual edit.
- Codex `trust_level` field is documented for `config.toml`; if the user's Codex version doesn't support it, the merge is silently a no-op (codex ignores unknown sections) — but approval prompts won't be bypassed. Worth logging during init whether the codex version is supported.
- Claude Code `enabledMcpjsonServers` key name has been stable in recent versions; verify against the installed Claude Code version if users report it not working.

### Sources

Verified via documentation:
- Claude Code: `permissions.allow` + `enabledMcpjsonServers` (standard).
- Codex: `[projects."<path>"] trust_level = "trusted"` — https://developers.openai.com/codex/config-reference
- OpenCode: `permission.mcp.<server>: "allow"` — https://opencode.ai/docs/permissions/

## Out of Scope (revisit later if data shows need)

- Tenet-side resource isolation (env-var contract for ports / temp dirs / DB paths).
- Structured verification ledger (DB-backed command results).
- Runtime artifact ownership registry (lock-file / port / temp-DB tracking).
- Harness determinism gate (separate phase running tests twice + concurrency probe).
- Journal consolidation automation.

These are documented in the Codex retrospective as P1/P2 and may earn promotion if a future run shows they're still blocking after Parts 1-3 land.

## Success Criteria

A repeat of the Codex-style 10-hour run on a stateful web project should:

1. Have **zero false failures** caused by parallel critics colliding on shared state (because readiness will mark `eval_parallel_safe=false` and Tenet will serialize).
2. Have **zero "report-only job edited files"** scope-violation failures (because the agent uses the remediation escape hatch).
3. Surface in the final status whether Layer 2 Playwright was actually executed or skipped.
4. Allow the orchestrator to route critic findings by category (product / test / harness / evidence / contention / scope) instead of generic retry.

A measurable proxy: the same project should converge in materially fewer than 266 jobs, with a much smaller failure-journal count.

Additionally, for Part 4: a user with a non-default model setup (e.g. github-copilot only) should be able to run Tenet end-to-end by setting `tenet config --opencode-args "--model X"` once, with no other code changes required.
