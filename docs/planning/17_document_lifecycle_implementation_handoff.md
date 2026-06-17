# 17 - Document Lifecycle Implementation Handoff

**Created**: 2026-06-12
**Status**: Implementation planning handoff (migration stance superseded — see Update below)
**Update (2026-06-17)**: The migration stance in this handoff was overridden
  after implementation. V1 below deliberately excluded migration ("do not
  silently migrate user projects"). That no longer holds: `tenet init --upgrade`
  now performs a one-time, breaking migration that MOVES legacy doc dirs
  (`spec/`, `interview/`, `decomposition/`, `harness/`, `journal/`, `visuals/`,
  `bootstrap/`, `steer/`, `knowledge/`, `DESIGN.md`) into `.tenet/archive/legacy-v1/`
  (bootstrap later curates durable facts from archived knowledge/ back into a
  fresh top-level knowledge/), accepting that pre-migration jobs' `artifact_paths`
  dangle. See README "Upgrading from ≤ 26.6.0". The "no silent migration on
  init/upgrade" lines below (Critical Reading Notes, Source Requirements,
  job-3, e2e-2, Completion Audit) are superseded by this update.
**Primary source**: `docs/planning/16_document_lifecycle.md`
**Second source**: `skills/tenet/SKILL.md` and `skills/tenet/phases/*.md`

This document is the practical implementation handoff for a future Codex `/goal`
run. It exists because `16_document_lifecycle.md` defines the desired lifecycle
shape, while the current Tenet skill and tools still encode the legacy document
model. A future agent should read both documents before editing code:

1. `docs/planning/16_document_lifecycle.md` - product/design intent and
   lifecycle invariants.
2. This file - execution plan, current-state map, job DAG, and testing strategy.

## Suggested Future `/goal` Prompt

Use this prompt when reopening Codex:

```text
Read docs/planning/16_document_lifecycle.md and
docs/planning/17_document_lifecycle_implementation_handoff.md. Treat 16 as the
design source and 17 as the implementation handoff. Inspect the current
worktree before relying on either document. Implement the Tenet document
lifecycle V1 according to those docs. Preserve exact artifact_paths behavior,
update/rename the existing Phase 00 into context bootstrap, do not introduce a
new lifecycle skill in the first pass, do not add a runs DB table, keep legacy
artifact paths readable as compatibility lanes, and add/update the tests named
in the handoff. Ask me before guessing on any open implementation question.
```

## Critical Reading Notes

The lifecycle design document contains a section named "Lifecycle Skill" that
suggests a `tenet-document-lifecycle` skill. Do not implement that as the first
step. For the first implementation pass, update the existing Tenet skill and its
Phase 00 routing. Introducing a separate copied skill first creates two sources
of truth and leaves normal Tenet runs using the old paths.

The first implementation should:

- update and rename the existing `00-brownfield-scan` phase into context
  bootstrap;
- update the Tenet skill router to call that phase before normal work when
  `.tenet/project/` is missing or unusable;
- update the existing phase files so new runs write run-local documents;
- update MCP/CLI behavior to support the lifecycle layout while preserving
  legacy compatibility.

The first implementation should not:

- add a new `skills/tenet-document-lifecycle/` directory;
- add a `runs` database table;
- silently migrate user projects;
- delete legacy `.tenet/` evidence;
- reconstruct old top-level specs as fake historical runs;
- keep `.tenet/harness/current.md` as an active future harness;
- keep `.tenet/DESIGN.md` as the active future design doctrine;
- make `status/` or `steer/` part of durable project doctrine;
- introduce thin/stale scoring into the bootstrap gate.

## Source Requirements To Preserve

From `16_document_lifecycle.md`:

- Existing exact `artifact_paths` remain authoritative.
- `tenet_compile_context(job_id)` should use the job UUID only to resolve the
  SQLite job row, not to derive document paths.
- SQLite remains the runtime source of truth for jobs and steer messages.
- `knowledge/` and journal-like history should be listed selectively, not fully
  inlined by default.
- The new human-readable document unit is a run:
  `.tenet/runs/<run-slug>/`.
- `project/` is durable doctrine and must be protected from normal job churn.
- Bootstrap is pass/fail and live-scan-first.
- Bootstrap may use archived Tenet evidence, but current implementation,
  tests, config, and runtime behavior are stronger evidence.
- Final `project/**` docs must describe current baseline only. They must not
  contain migration commentary or legacy conflict analysis.
- Migration is explicit maintenance work, not normal execution.
- Stage A keeps legacy top-level artifact directories readable.
- Stage B makes new jobs use run-local artifacts and makes `compile_context`
  read `project/*` plus exact run artifacts.
- `run_slug` and `run_path` are stored additively in job params.
- No V1 `runs` DB table.
- Normal implementation jobs must not edit `.tenet/project/**`.
- Eval should fail normal jobs that edit `.tenet/project/**` without explicit
  doctrine/bootstrap authorization.

From the current Tenet skill:

- The top-level skill is an index and must route through phase files.
- Phase files are authoritative for their phase.
- MCP tool schemas and tool results outrank skill prose.
- Execution jobs must flow through Tenet MCP; do not manually bypass the job
  loop.
- Readiness still validates exact artifact paths.
- Eval remains a hard gate after each completed job.

## Current-State Map

The current implementation still reflects the legacy layout.

### Skill Files

- `skills/tenet/SKILL.md`
  - Boot Sequence runs `phases/00-brownfield-scan.md` only after new `.tenet/`
    creation on brownfield projects.
  - Phase Map names "Brownfield scan" and points to
    `phases/00-brownfield-scan.md`.
  - Knowledge and journal instructions write through `tenet_update_knowledge`
    without run-local routing.

- `skills/tenet/phases/00-brownfield-scan.md`
  - Writes `.tenet/bootstrap/codebase-scan.md`.
  - Does not create `.tenet/project/**`.
  - Does not perform the lifecycle bootstrap gate.
  - Does not require sub-agent investigation lanes.

- `skills/tenet/phases/01-interview.md`
  - Writes `.tenet/interview/{date}-{feature}.md`.

- `skills/tenet/phases/02-spec-and-harness.md`
  - Writes `.tenet/spec/{date}-{feature}.md`.
  - Writes `.tenet/harness/current.md`.
  - Writes `.tenet/spec/scenarios-{date}-{feature}.md`.
  - Readiness example passes `.tenet/harness/current.md`.

- `skills/tenet/phases/03-visuals.md`
  - Writes `.tenet/visuals/`.
  - Writes `.tenet/DESIGN.md`.
  - Tells future frontend jobs to read and update `DESIGN.md`.

- `skills/tenet/phases/04-decomposition.md`
  - Writes `.tenet/decomposition/{date}-{feature}.md`.
  - Registers jobs with legacy artifact paths.
  - Does not mention `run_slug` or `run_path`.

- `skills/tenet/phases/05-execution-loop.md`
  - Writes journals through `tenet_update_knowledge(type="journal")`.
  - Refers to `.tenet/journal/` failure logs.

- `skills/tenet/phases/06-evaluation.md`
  - Does not enforce the new `.tenet/project/**` write boundary.

- `skills/tenet/phases/07-agile-checkpoints.md`
  - Applies redirects to legacy spec paths.

### CLI And MCP

- `src/cli/init.ts`
  - `REQUIRED_DIRS` creates legacy directories:
    `interview`, `spec`, `harness`, `status`, `knowledge`, `journal`,
    `steer`, `bootstrap`, `visuals`, `state-snapshot`.
  - Template files include `.tenet/harness/current.md`,
    `.tenet/steer/inbox.md`, `.tenet/steer/processed.md`, and
    `.tenet/bootstrap/compiler.md`.
  - Upgrade preserves existing user docs.

- `src/mcp/tools/tenet-init.ts`
  - MCP init has its own required-dir list and should be checked when CLI init
    changes.

- `src/mcp/tools/tenet-register-jobs.ts`
  - Requires `feature`.
  - Optionally normalizes and stores `artifact_paths`.
  - Does not accept or store `run_slug` / `run_path`.

- `src/mcp/tools/tenet-compile-context.ts`
  - Reads exact `artifact_paths` when present.
  - Falls back to top-level feature files.
  - Inlines legacy harness.
  - Lists top-level `.tenet/knowledge/` and `.tenet/journal/`.
  - Inlines `status`, `steer/inbox.md`, and `bootstrap/codebase-scan.md`.
  - Does not inline `.tenet/project/*.md`.
  - Does not list run-local `journal/`, `research/`, or `visuals/`.
  - Does not ignore `.tenet/archive/` because it never looks there yet.

- `src/mcp/tools/tenet-update-knowledge.ts`
  - Writes `knowledge` to `.tenet/knowledge/`.
  - Writes `journal` to `.tenet/journal/`.
  - Does not inspect job params for `run_path`.

- `src/mcp/tools/tenet-validate-readiness.ts`
  - Supports exact artifact paths.
  - Fallback still expects top-level spec and `.tenet/harness/current.md`.

- `src/mcp/tools/tenet-start-eval.ts`
  - Critic prompts know `scope_conflict` in general.
  - Prompts do not explicitly fail normal jobs that edit `.tenet/project/**`.
  - Playwright eval preamble tells workers to read `.tenet/harness/current.md`.

- `src/core/job-manager.ts`
  - Retry prompt tells workers to check `.tenet/journal/`.

- `src/cli/index.ts`
  - Init output tells users to review `.tenet/harness/current.md`.

- `skills/tenet-diagnose/SKILL.md`
  - Expected `.tenet/` directories are legacy-only.

## Target V1 Behavior

New initialized projects should have:

```text
.tenet/
  project/
    overview.md
    architecture.md
    product.md
    testing.md
    design.md
    design-components/
  runs/
  knowledge/
  archive/
  status/
  state-snapshot/
```

Legacy compatibility directories can still be created or tolerated during Stage
A, but normal new-run instructions should not point agents there as active
targets:

```text
.tenet/interview/
.tenet/spec/
.tenet/decomposition/
.tenet/harness/
.tenet/journal/
.tenet/visuals/
.tenet/bootstrap/
.tenet/steer/
```

New run artifacts should look like:

```text
.tenet/runs/2026-06-12-document-lifecycle/
  interview.md
  spec.md
  scenarios.md
  decomposition.md
  harness.md
  design.md
  research/
  journal/
  visuals/
```

Registered jobs for that run should carry:

```json
{
  "feature": "document-lifecycle",
  "run_slug": "2026-06-12-document-lifecycle",
  "run_path": ".tenet/runs/2026-06-12-document-lifecycle",
  "artifact_paths": {
    "spec": ".tenet/runs/2026-06-12-document-lifecycle/spec.md",
    "harness": ".tenet/runs/2026-06-12-document-lifecycle/harness.md",
    "scenarios": ".tenet/runs/2026-06-12-document-lifecycle/scenarios.md",
    "interview": ".tenet/runs/2026-06-12-document-lifecycle/interview.md",
    "decomposition": ".tenet/runs/2026-06-12-document-lifecycle/decomposition.md"
  }
}
```

`artifact_paths` remains the exact loading authority. `run_slug` and `run_path`
are grouping and routing metadata.

## Implementation DAG

### job-1-context-bootstrap-skill

**Depends on**: none

**Goal**: Replace Phase 00 brownfield scan with lifecycle context bootstrap.

**Files**:

- Rename `skills/tenet/phases/00-brownfield-scan.md` to
  `skills/tenet/phases/00-context-bootstrap.md`.
- Update `skills/tenet/SKILL.md`.

**Required behavior**:

- Phase Map says "Context bootstrap" and points to
  `phases/00-context-bootstrap.md`.
- Boot Sequence checks `.tenet/project/` before normal mode selection.
- Bootstrap gate is pass/fail only:
  - required `project/` docs exist;
  - required docs are not empty placeholders or obvious templates.
- Gate must not score "thin", "stale", or "needs improvement".
- On gate fail, normal execution stops and routes to context bootstrap.
- Context bootstrap is live-scan-first:
  - current repo implementation;
  - tests, scripts, config, CI, runtime behavior;
  - recent explicit decisions;
  - archived legacy evidence only as secondary evidence.
- Bootstrap requires bounded sub-agent investigation lanes.
- If sub-agents are unavailable, stop and ask for explicit user approval before
  degraded main-agent-only mode.
- Degraded mode must persist lane findings before each lane.
- Bootstrap writes final `project/**` docs without migration commentary.
- Bootstrap may curate durable reusable facts into top-level `.tenet/knowledge/`.

**Important interpretation**:

Do not create a separate lifecycle skill in this job. The existing Tenet skill
must be updated first so ordinary Tenet runs cannot miss the bootstrap gate.

### job-2-run-local-skill-contract

**Depends on**: `job-1-context-bootstrap-skill`

**Goal**: Update all Tenet phase instructions to produce and consume run-local
artifacts for new runs.

**Files**:

- `skills/tenet/SKILL.md`
- `skills/tenet/phases/01-interview.md`
- `skills/tenet/phases/02-spec-and-harness.md`
- `skills/tenet/phases/03-visuals.md`
- `skills/tenet/phases/04-decomposition.md`
- `skills/tenet/phases/05-execution-loop.md`
- `skills/tenet/phases/06-evaluation.md`
- `skills/tenet/phases/07-agile-checkpoints.md`

**Required behavior**:

- Establish `run_slug` early from `{date}-{feature}`.
- Create/use `.tenet/runs/<run-slug>/` for new run artifacts.
- Interview writes `runs/<run>/interview.md`.
- Spec writes `runs/<run>/spec.md`.
- Scenarios write `runs/<run>/scenarios.md`.
- Harness writes `runs/<run>/harness.md`.
- Decomposition writes `runs/<run>/decomposition.md`.
- Visual artifacts write `runs/<run>/visuals/`.
- Run-local design deltas write `runs/<run>/design.md`.
- Global design doctrine is `.tenet/project/design.md`, not `.tenet/DESIGN.md`.
- `project/design-components/` is listed/consulted for accepted reusable
  patterns, not overwritten by normal jobs.
- Pre-spec and interview research writes to `runs/<run>/research/` unless
  explicitly promoted to curated top-level `knowledge/`.
- Journals write to `runs/<run>/journal/` by default.
- Readiness examples pass exact run-local artifact paths.
- `tenet_register_jobs` examples pass `run_slug`, `run_path`, and exact
  run-local `artifact_paths`.
- Agile redirects amend run-local spec/decomposition files.
- Execution-loop journal guidance names run-local journal paths.
- Evaluation phase includes `.tenet/project/**` write-boundary enforcement.

**Compatibility notes**:

- Legacy top-level artifact paths remain valid if present in exact
  `artifact_paths`.
- Feature-only fallback is explicitly compatibility-only.
- Existing projects are not silently migrated by this skill update.

### e2e-1-skill-contract-review

**Depends on**:

- `job-1-context-bootstrap-skill`
- `job-2-run-local-skill-contract`

**Goal**: Mechanically verify the skill contract no longer instructs new runs to
write active legacy docs.

**Checks**:

- `skills/tenet/SKILL.md` no longer names `00-brownfield-scan.md`.
- `skills/tenet/phases/00-context-bootstrap.md` exists.
- No new-run examples point to `.tenet/harness/current.md`.
- No new-run examples point to `.tenet/DESIGN.md`.
- New-run readiness and registration examples use `.tenet/runs/<run>/...`.
- Legacy top-level paths appear only in compatibility or migration language.

Suggested commands:

```bash
rg -n "00-brownfield-scan|harness/current|DESIGN.md|\\.tenet/spec|\\.tenet/interview|\\.tenet/decomposition|\\.tenet/visuals|\\.tenet/journal" skills/tenet
```

The command is not sufficient alone. Review every hit and decide whether it is
legacy compatibility language or an active instruction.

### job-3-init-lifecycle-scaffold

**Depends on**: `e2e-1-skill-contract-review`

**Goal**: Make `tenet init` scaffold lifecycle directories/templates.

**Files**:

- `src/cli/init.ts`
- `src/mcp/tools/tenet-init.ts`
- `src/cli/index.ts`
- `skills/tenet-diagnose/SKILL.md`

**Required behavior**:

- Add `.tenet/project/`.
- Add `.tenet/project/design-components/`.
- Add `.tenet/runs/`.
- Add `.tenet/archive/`.
- Add project templates:
  - `project/overview.md`
  - `project/architecture.md`
  - `project/product.md`
  - `project/testing.md`
  - `project/design.md`
- Preserve `.tenet/status/` and `.tenet/state-snapshot/`.
- Keep legacy dirs in Stage A if needed for compatibility, but mark them as
  legacy compatibility lanes in comments/docs.
- Stop presenting `.tenet/harness/current.md` as the active user-edit target for
  new projects.
- Do not overwrite existing user docs on upgrade.

**Template guidance**:

Project templates can exist as bootstrap placeholders, but the bootstrap gate
must be able to detect obvious placeholders and fail until context bootstrap
synthesizes usable doctrine.

### job-4-register-run-identity

**Depends on**: `e2e-1-skill-contract-review`

**Goal**: Store run identity on every registered job without changing DB schema.

**Files**:

- `src/mcp/tools/tenet-register-jobs.ts`
- `src/types/index.ts` if type declarations need updates
- tests for register jobs

**Required behavior**:

- Input schema accepts optional `run_slug`.
- Input schema accepts optional `run_path`.
- `run_path` is normalized to project-relative POSIX style and must stay inside
  the project.
- If `run_path` is provided, it should normally point under `.tenet/runs/`.
  Decide whether to enforce this strictly or warn; if ambiguous, ask the user.
- Every created job stores:
  - `feature`
  - `run_slug` when provided
  - `run_path` when provided
  - normalized `artifact_paths` when provided
- Response echoes normalized `run_slug` / `run_path`.
- Jobs with only legacy `feature` and `artifact_paths` still work.
- No DB migration and no `runs` table.

### job-5-compile-context-lifecycle

**Depends on**:

- `job-3-init-lifecycle-scaffold`
- `job-4-register-run-identity`

**Goal**: Compile precise lifecycle context for jobs.

**Files**:

- `src/mcp/tools/tenet-compile-context.ts`
- `src/mcp/tools/artifact-paths.ts` if reusable path helpers are needed
- compile-context tests

**Required behavior**:

- Continue using `job_id` only to load the SQLite job row.
- Continue reading exact `artifact_paths` when present.
- Inline project doctrine:
  - `.tenet/project/overview.md`
  - `.tenet/project/architecture.md`
  - `.tenet/project/product.md`
  - `.tenet/project/testing.md`
  - `.tenet/project/design.md`
- Inline exact current-run artifacts from `artifact_paths`:
  - spec
  - scenarios
  - harness
  - decomposition
  - interview when present
- List by filename, not full inline:
  - `.tenet/runs/<run>/journal/*`
  - `.tenet/runs/<run>/research/*`
  - `.tenet/runs/<run>/visuals/*`
  - `.tenet/knowledge/*`
  - `.tenet/project/design-components/*`
- Mention archive only as "archived legacy evidence exists" when present.
- Do not inline `.tenet/archive/**` by default.
- Do not inline an entire run directory.
- Preserve legacy fallback behavior when no `artifact_paths` exist, but keep
  warnings/compatibility framing.
- Avoid inlining `status/` and `steer/` as doctrine. If status remains useful,
  label it as generated runtime status.

### job-6-knowledge-journal-routing

**Depends on**: `job-4-register-run-identity`

**Goal**: Route journal writes to run-local journal directories while preserving
top-level curated knowledge.

**Files**:

- `src/mcp/tools/tenet-update-knowledge.ts`
- `src/core/job-manager.ts`
- related tests

**Required behavior**:

- `type="knowledge"` continues writing to `.tenet/knowledge/`.
- `type="journal"` writes to `.tenet/runs/<run>/journal/` when the source job
  has a valid `run_path`.
- Legacy jobs without `run_path` keep writing to `.tenet/journal/`.
- Tool response should return a project-relative file path, not only filename,
  because journal location is now conditional.
- Prompt text and retry context should point to run-local journal paths when
  available.

**Optional extension**:

Add explicit tool input such as `scope: "run" | "global"` only if needed. The
minimal V1 can infer routing from `job_id`.

### job-7-readiness-and-eval-boundaries

**Depends on**:

- `job-2-run-local-skill-contract`
- `job-5-compile-context-lifecycle`

**Goal**: Align validation and eval prompts with lifecycle paths and write
authority.

**Files**:

- `src/mcp/tools/tenet-validate-readiness.ts`
- `src/mcp/tools/tenet-start-eval.ts`
- readiness/eval tests

**Required behavior**:

- Readiness supports exact run-local artifact paths.
- Fallback remains legacy-only and warns.
- Error messages prefer "pass exact artifact_paths" over telling users to write
  `.tenet/harness/current.md`.
- Playwright eval preamble no longer instructs workers to read
  `.tenet/harness/current.md`; it should read compiled context or exact run
  artifacts/project docs.
- Code critic prompt explicitly treats unauthorized `.tenet/project/**` edits
  as `scope_conflict`.
- Test critic/e2e prompts should not require project doctrine edits.
- Authorized doctrine/bootstrap jobs need an explicit marker in params or prompt
  if they are allowed to edit `.tenet/project/**`. Keep this minimal in V1.

### e2e-2-lifecycle-tool-tests

**Depends on**:

- `job-3-init-lifecycle-scaffold`
- `job-4-register-run-identity`
- `job-5-compile-context-lifecycle`
- `job-6-knowledge-journal-routing`
- `job-7-readiness-and-eval-boundaries`

**Goal**: Verify lifecycle behavior at tool level.

**Checks**:

- New init scaffold has lifecycle directories and templates.
- Upgrade preserves existing docs.
- Register-jobs stores run identity on all jobs.
- Compile-context inlines project docs and exact run artifacts.
- Compile-context lists run-local evidence and global knowledge.
- Compile-context ignores archive by default.
- Knowledge writes remain top-level.
- Journal writes become run-local with `run_path`.
- Legacy jobs without `run_path` still work.
- Readiness accepts run-local exact artifact paths.
- Eval prompt includes project write-boundary enforcement.

## Suggested Test Plan

Run targeted tests during implementation, then full project verification after
the final job.

### Unit Tests To Add Or Extend

#### `src/cli/init.test.ts`

Add assertions that fresh init creates:

- `.tenet/project/`
- `.tenet/project/overview.md`
- `.tenet/project/architecture.md`
- `.tenet/project/product.md`
- `.tenet/project/testing.md`
- `.tenet/project/design.md`
- `.tenet/project/design-components/`
- `.tenet/runs/`
- `.tenet/archive/`

Update copied phase-doc tests to expect `00-context-bootstrap.md`.

Add upgrade assertions:

- upgrade creates new lifecycle dirs;
- upgrade does not overwrite existing project docs;
- upgrade still refreshes copied skill docs.

#### `src/mcp/tools/tenet-register-jobs.test.ts`

Add tests:

- stores `run_slug` and normalized `run_path` on every job;
- response echoes normalized run fields;
- rejects `run_path` outside project;
- preserves existing artifact path behavior;
- old registration without run fields still warns only about missing
  `artifact_paths`, not about missing run identity.

#### `src/mcp/tools/tenet-compile-context.test.ts`

Add tests:

- reads exact run-local artifact paths instead of stale legacy files;
- inlines all existing `project/*.md` docs;
- does not fail when optional project docs are missing during compatibility
  mode, unless the bootstrap gate owns that failure elsewhere;
- lists `runs/<run>/journal`, `runs/<run>/research`, and
  `runs/<run>/visuals` filenames;
- lists `.tenet/knowledge/*`;
- lists `.tenet/project/design-components/*`;
- does not inline `.tenet/archive/legacy-v1/**`;
- still rejects missing exact artifact paths;
- legacy fallback still works for old jobs without `artifact_paths`.

#### New or extended `tenet-update-knowledge` tests

If no test file exists, add `src/mcp/tools/tenet-update-knowledge.test.ts`.

Add tests:

- `type="knowledge"` writes `.tenet/knowledge/<date>_<slug>.md`;
- `type="journal"` with source job `run_path` writes
  `.tenet/runs/<run>/journal/<date>_<slug>.md`;
- `type="journal"` without `run_path` writes legacy `.tenet/journal/`;
- response returns a project-relative `file` or `path` that distinguishes the
  actual location;
- invalid job IDs are handled consistently with existing behavior.

#### `src/mcp/tools/tenet-validate-readiness.test.ts`

Add tests:

- exact run-local artifact paths are accepted;
- deterministic preflight failures include run-local artifact paths in job
  params;
- fallback warning is still emitted for legacy feature lookup;
- error messages do not force `.tenet/harness/current.md` when exact paths are
  available.

#### `src/mcp/tools/tenet-start-eval.test.ts`

Add tests:

- code critic prompt includes unauthorized `.tenet/project/**` edits as a
  `scope_conflict`;
- playwright eval prompt no longer hardcodes `.tenet/harness/current.md`;
- eval mode behavior remains unchanged.

#### Optional grep-based regression tests

Add lightweight tests only if they are stable and not too brittle:

- skill copied phase list includes `00-context-bootstrap.md`;
- no active phase examples register `.tenet/harness/current.md` for new runs;
- no active phase examples write `.tenet/DESIGN.md`.

Manual `rg` review may be better than brittle assertions for prose.

### Commands

During development:

```bash
npx vitest run src/cli/init.test.ts
npx vitest run src/mcp/tools/tenet-register-jobs.test.ts
npx vitest run src/mcp/tools/tenet-compile-context.test.ts
npx vitest run src/mcp/tools/tenet-update-knowledge.test.ts
npx vitest run src/mcp/tools/tenet-validate-readiness.test.ts
npx vitest run src/mcp/tools/tenet-start-eval.test.ts
```

Final verification:

```bash
make typecheck
make test
```

If final full test is too slow or fails for unrelated environment reasons, run
the targeted tests above and report the limitation clearly. Do not claim full
verification without command evidence.

## Completion Audit Checklist

Before marking the future implementation complete, verify every item below from
current files and test output.

### Source Alignment

- `16_document_lifecycle.md` remains the design source.
- This handoff remains consistent with the implemented shape or is updated.
- Existing `artifact_paths` behavior is preserved.
- `run_slug` / `run_path` are additive, not DB schema changes.
- No `runs` DB table exists.
- No silent migration runs during normal init/upgrade.

### Skill Contract

- Phase 00 is context bootstrap, not brownfield scan.
- Boot Sequence runs the project-doc bootstrap gate before normal phases.
- Bootstrap gate is pass/fail only.
- New-run phase docs use `.tenet/runs/<run>/...`.
- Project doctrine is `.tenet/project/**`.
- Normal jobs are told not to edit `.tenet/project/**`.
- `.tenet/harness/current.md` and `.tenet/DESIGN.md` are legacy-only in new-run
  instructions.

### Init And Compatibility

- Fresh `tenet init` creates lifecycle dirs/templates.
- Upgrade creates missing lifecycle dirs without overwriting user docs.
- Legacy directories remain readable in Stage A.
- Generated skill copies include the renamed Phase 00 file.
- Diagnose/help text does not teach the old layout as the only expected layout.

### Tool Behavior

- `tenet_register_jobs` stores run identity.
- `tenet_compile_context` inlines project docs and exact current-run artifacts.
- `tenet_compile_context` lists evidence directories instead of inlining raw
  history.
- `tenet_compile_context` ignores archive by default.
- `tenet_update_knowledge` routes journals run-locally when possible.
- `tenet_validate_readiness` supports run-local exact artifact paths.
- `tenet_start_eval` enforces project doctrine write authority in critic prompt.

### Test Evidence

- Targeted tests pass.
- `make typecheck` passes.
- `make test` passes, or any limitation is documented with exact failing command
  and reason.

## Open Implementation Questions

Ask the user instead of guessing if these become blocking:

1. Should `tenet_register_jobs` strictly require `run_path` to be under
   `.tenet/runs/`, or only require it to be inside the project?
2. Should fresh init still create legacy top-level artifact directories in Stage
   A, or should they be created lazily only for compatibility paths?
3. How should doctrine/bootstrap authorization be represented in job params for
   eval enforcement: job type, explicit param, or prompt convention?
4. Should `tenet_validate_readiness` fallback read `.tenet/project/testing.md`
   plus legacy harness, or should fallback remain exactly legacy until exact
   artifact paths are supplied?

Default implementation stance:

- Be strict about paths staying inside the project.
- Preserve legacy lanes during Stage A.
- Keep V1 authorization minimal and explicit.
- Prefer exact `artifact_paths` for all new lifecycle behavior.
