# 16 — Tenet Document Lifecycle

**Created**: 2026-06-10
**Status**: Design discussion
**Origin**: Long-running Tenet projects accumulate `.tenet/` artifacts; `podcast-gen-web-service` showed global docs being edited as job-local context and historical artifacts becoming hard to navigate.

---

## Motivation

Tenet's current document model preserves a lot of useful evidence, but it does not draw a strong enough boundary between:

- global project doctrine,
- run-local scope and acceptance contracts,
- raw execution evidence,
- curated reusable knowledge,
- generated artifacts.

That ambiguity has two bad effects.

First, jobs mutate global-looking documents such as `harness/current.md` and `DESIGN.md` when the job only needed a local harness or local visual direction. Those files are supposed to describe the project broadly; they should not be shaken by each job.

Second, long-running projects accumulate many dated specs, decompositions, journals, visuals, retries, and generated artifacts. Some of that history is valuable for finding what worked, what failed, and why. But without a lifecycle model, future agents and humans have to infer authority from filenames and timestamps.

The goal is not to make every agent write perfectly formatted documentation. That will not happen reliably. The goal is to provide a document structure where imperfect agent output is still useful and where durable project truth is protected from local job churn.

## Existing Behavior To Preserve

Today, Tenet already has several good primitives:

- `tenet_register_jobs` stores a human feature slug and exact `artifact_paths` on every registered job.
- `tenet_compile_context(job_id)` resolves a runtime SQLite UUID to the job record, then reads the exact artifact paths when present.
- Feature-scoped files use dated filenames such as `.tenet/spec/2026-04-08-oauth.md`.
- `knowledge/` and `journal/` are listed by filename in compiled context, not fully inlined.
- SQLite remains the runtime source of truth for jobs and steer messages.

The lifecycle design should extend these primitives rather than replace them wholesale.

## Core Principles

### 1. Runs Are The Human-Readable Unit

Do not use runtime job UUIDs as document paths. UUIDs are MCP/runtime state, not document identity.

Do not use DAG IDs such as `job-1` as top-level document containers either. A single spec/decomposition produces multiple DAG jobs, and `job-1` is only meaningful inside one decomposition.

The human-readable unit is the run:

```text
.tenet/runs/2026-06-10-production-readiness/
```

One run contains one local spec, one local decomposition, one local harness, local journals, local visuals, and local research.

### 2. Agents Produce Evidence; Tenet Provides Shelves

Assume agents will skip procedures and write imperfect docs.

Therefore, correctness should not depend on agents maintaining an `index.md`, writing a perfect end-of-run `summary.md`, or remembering to promote every finding.

Instead, directory structure and `artifact_paths` should make the common case reliable:

- normal jobs write run-local evidence,
- global doctrine lives elsewhere,
- compiled context follows exact paths,
- semantic cleanup is an explicit skill workflow, not hidden behavior.

### 3. Project Doctrine Is Protected

`project/` should be project doctrine: the durable description of what the project is, how it is structured, how it should evolve, how it is tested, and what design system it follows.

Normal implementation jobs should not casually edit `project/`. They may discover that `project/` is stale, but that should become a proposed doctrine update or a dedicated doctrine/synthesis job.

### 4. Compile Context Should Include Less, More Precisely

Moving docs under `runs/` must not cause `tenet_compile_context` to inline an entire run directory.

Compiled context should inline small authoritative docs and the run-local contract for the current job. Raw history should usually be presented as filenames for selective reading.

### 5. Bootstrap Is Pass/Fail And Live-Scan-First

Context bootstrap should be a bootstrap gate, not a stale-doc audit.

The gate should only decide whether `.tenet/project/` is usable enough for normal Tenet work to continue. It should not classify project docs as "thin", "stale", or "needs improvement"; those judgments belong to later lifecycle maintenance.

When bootstrap is needed, current project implementation is the primary evidence. Legacy Tenet documents are secondary evidence for intent, long-term rules, durable decisions, and lessons that may belong in `knowledge/`.

Final `project/**` documents should describe the project as it is now. They should not contain migration commentary, legacy-vs-current conflict notes, or old intent that no longer describes the project.

### 6. Semantic Audit Is A Skill, Not A Deterministic Tool

A program can inventory files: sizes, dates, tracked state, broken path references, and exact `artifact_paths`.

It cannot reliably decide which doc is authoritative, whether a local design note should become global doctrine, or whether two natural-language docs contradict each other.

Document lifecycle audit should therefore be a skill that uses mechanical probes, reads representative documents, makes labeled inferences, and asks before modifying files.

## Current Implementation Shape

This is what Tenet supports today before the lifecycle redesign. These paths are grounded in `tenet init`, the MCP tools, and the bundled Tenet skill.

```text
.tenet/
  .state/                         # live SQLite runtime state; not documentation
  bootstrap/
    codebase-scan.md              # brownfield project scan when present
    compiler.md
  decomposition/
    {date}-{feature}.md
  harness/
    current.md                    # singular project-wide quality contract today
  interview/
    {date}-{feature}.md
  journal/
    {date}_{title}.md             # job/session history from tenet_update_knowledge(type="journal")
  knowledge/
    {date}_{title}.md             # reusable memory/research from tenet_update_knowledge(type="knowledge")
  spec/
    {date}-{feature}.md
    scenarios-{date}-{feature}.md
  state-snapshot/
  status/
    status.md
    job-queue.md
    backlog.md
  steer/
    inbox.md
    processed.md
  visuals/
    {date}-NN-description.html
  DESIGN.md                       # created by the visual phase for frontend projects; not scaffolded by init
```

Important current constraints:

- `tenet_update_knowledge` can write only top-level `.tenet/knowledge/` or `.tenet/journal/`.
- `tenet_compile_context` inlines exact `artifact_paths` when present, otherwise falls back to top-level dated feature docs.
- `tenet_compile_context` lists top-level `knowledge/` and `journal/` filenames only.
- `harness/current.md` and `DESIGN.md` currently carry global-looking doctrine but are also touched by feature work, which is one cause of drift.

## Working Target Shape

New projects and new runs should move toward this shape:

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
    2026-06-10-production-readiness/
      interview.md
      spec.md
      scenarios.md
      decomposition.md
      harness.md
      design.md
      research/
      journal/
      visuals/

  knowledge/
    worker-queue.md
    transcript-sync.md
    frontend-i18n.md

  archive/
    legacy-v1/

  state-snapshot/
  status/
```

`project/` is deliberately not named `current/`. "Current" sounds like runtime state or the latest run; `project/` means stable project-level doctrine.

Existing top-level directories remain compatibility lanes until the tools and migration process are updated:

```text
.tenet/interview/
.tenet/spec/
.tenet/decomposition/
.tenet/harness/
.tenet/journal/
.tenet/visuals/
```

Do not require an immediate migration for old projects. `artifact_paths` can point to either old top-level paths or new run-local paths.

## Directory Semantics

### `.tenet/project/`

Global durable project doctrine. It should be small enough to read often.

Suggested files:

| File | Purpose |
|---|---|
| `overview.md` | What this project is now, key directory structure, repository rules, and what the structure should look like as development continues. |
| `architecture.md` | Current system boundaries, data flow, integration contracts, and major architectural decisions. |
| `product.md` | User-facing product behavior, non-goals, and stable requirements. |
| `testing.md` | Global quality contract, commands, fixture rules, test strategy, and known verification gaps. |
| `design.md` | Required experience-design doctrine: how intended users experience and operate the project. |
| `design-components/` | Optional curated reusable component examples for UI or other concrete interaction surfaces. |

`project/` replaces the global role previously mixed into `harness/current.md` and `DESIGN.md`.

### `.tenet/runs/<run-slug>/`

Run-local working context and evidence.

Suggested files:

| Path | Purpose |
|---|---|
| `interview.md` | Questions, answers, and clarifications for this run. Durable product truths can later be reflected in `project/product.md`. |
| `spec.md` | What this run is trying to make true. |
| `scenarios.md` | Run-local success scenarios and anti-scenarios. |
| `decomposition.md` | DAG plan for this run, including `job-1`, `job-2`, `e2e-1`, and interfaces between jobs. |
| `harness.md` | Run-specific quality and acceptance contract. This is the right place for job-local constraints. |
| `design.md` | Optional run-local visual direction or delta. Global visual doctrine remains in `project/design.md`. |
| `research/` | Raw research gathered for this run. |
| `journal/` | Run-local job logs, retries, eval notes, blockers, and recovery notes. |
| `visuals/` | Run-local explorations, mockups, revisions, screenshots, and prototypes. |

Journals should be run-local by default. A global journal becomes an unhelpful pile when it mixes many runs, retries, and eval events.

### Legacy `.tenet/harness/current.md`

`harness/current.md` should not remain an active future document or generated mirror.

The old harness role was overloaded: it mixed project workflow, architecture constraints, product acceptance principles, verification rules, design expectations, and job-local harness details. That overloading is one cause of drift because agents modify it while interviewing or specifying one feature.

In the lifecycle layout, its responsibilities split across concern-specific project docs and run-local harnesses:

```text
harness/current.md project-wide content
  -> project/overview.md       # repo workflow, directory rules, operating assumptions
  -> project/architecture.md   # architectural constraints and invariants
  -> project/product.md        # product acceptance principles, non-goals, user behavior
  -> project/testing.md        # verification commands, test strategy, quality gates
  -> project/design.md         # UX/design rules if present
  -> knowledge/*.md            # durable lessons, recurring mistakes, gotchas
```

Future active harness files are run-local only:

```text
.tenet/runs/<run>/harness.md
```

That file is the run-specific acceptance contract derived from the run spec plus relevant `project/*.md` doctrine.

### `.tenet/knowledge/`

Curated reusable memory, not raw research dumps.

Run-specific research starts under `runs/<run>/research/`. If it becomes generally useful, it can be promoted into a concern-oriented knowledge file such as:

```text
.tenet/knowledge/worker-queue.md
.tenet/knowledge/transcript-sync.md
.tenet/knowledge/frontend-i18n.md
```

Promotion is semantic work. It should be done by a document lifecycle skill or explicit synthesis job, not assumed after every run.

### `.tenet/status/`

Generated runtime export, not lifecycle documentation.

The source of truth is SQLite job, event, and runtime state. Files such as `status/status.md` and `status/job-queue.md` are generated mirrors for humans, recovery, and non-MCP readers.

Do not hand-maintain `status/` as project doctrine. Do not migrate it into `project/`. Context bootstrap may inspect it as weak operational evidence when useful, but `status/` should not be part of the durable document lifecycle.

### `.tenet/steer/`

Legacy-only in the lifecycle layout.

Current Tenet steering is actually handled through MCP/SQLite. The scaffolded `.tenet/steer/*` files are not updated by the MCP steer tool and agents are not reliably reading them. Keeping top-level steer documents active would create another stale-document surface.

For V1 lifecycle:

- no active top-level `.tenet/steer/`,
- archive existing `.tenet/steer/` under `archive/legacy-v1/steer/` during migration,
- do not include steer in `project/`,
- do not include steer in context-bootstrap synthesis.

If file-readable steering becomes useful later, introduce it as a generated, read-only run-local surface only after tools actually write it and agents are instructed to read it:

```text
.tenet/runs/<run>/steer/
```

Do not create that run-local steer directory in V1.

## Context Bootstrap

Context bootstrap is the phase that establishes `.tenet/project/` when Tenet cannot trust that project doctrine exists yet.

It is not normal feature work. It is not recurring document freshness review. It is a bootstrap or recovery phase that turns live implementation evidence, and optionally archived Tenet evidence, into a clean current baseline.

### Bootstrap Gate

The Tenet skill should check `.tenet/project/` before normal job flow.

The gate is intentionally pass/fail:

```text
Pass:
- `.tenet/project/` exists.
- Required baseline docs exist.
- Required docs are not empty placeholders or obvious templates.

Fail:
- `.tenet/project/` is missing.
- Required baseline docs are missing.
- Required docs are clearly unusable as project context.
```

The gate should not attempt to decide whether docs are thin, stale, incomplete, or merely improvable. Those are lifecycle maintenance concerns, not bootstrap concerns.

On fail, normal job execution should stop and Tenet should suggest or enter context bootstrap. If `.tenet/archive/` exists and contains legacy documents, bootstrap uses both live project scanning and archived evidence scanning. If no archive exists, bootstrap is a brownfield live-project scan.

For greenfield projects with no meaningful live implementation yet, initial `project/**` doctrine should start from templates and the first crystallization decisions after the user interview/spec/design work, then be refreshed by later bootstrap or lifecycle maintenance once implementation evidence exists.

### Evidence Priority

Bootstrap is live-scan-first.

Final `project/**` documents should be synthesized from evidence in this order:

1. Current implementation and repository structure.
2. Current tests, package scripts, config, CI, and runtime behavior.
3. Recent explicit user/project decisions.
4. Legacy Tenet documents, only when they clarify intent, long-term rules, or decisions that are still consistent with the live project.

Legacy evidence should not be copied into `project/**` as historical explanation. Conflict analysis and migration reasoning are temporary bootstrap working material. The final project docs should state the resolved current baseline only.

Durable historical lessons, repeated mistakes, constraints, and useful gotchas belong in top-level `.tenet/knowledge/`, not in `.tenet/project/`.

### Investigation Lanes

The main agent is the orchestrator and synthesizer. It should not be the primary investigator for every lane because that recreates the context-length problem bootstrap is meant to solve.

Bootstrap should spawn parallel sub-agents for bounded investigation lanes. The exact lanes can be adjusted after inventory, but a useful default split is:

| Lane | Main question |
|---|---|
| Live overview | What is the repository now, and what directory/module rules matter? |
| Live architecture | What are the current runtime boundaries, data flow, integrations, and persistence model? |
| Live product | What user-facing behavior is currently implemented? |
| Live testing | How is quality verified now, and which commands/fixtures/CI paths are authoritative? |
| Live design | What frontend design, component, styling, and asset conventions are implemented now? |
| Legacy intent | What product direction, accepted plans, or long-term constraints can be recovered from archived specs, decompositions, and interviews? |
| Legacy operations | What useful workflow, harness, retry, status, or journal lessons should survive? |
| Legacy design | What accepted visual/design decisions can be recovered from archived design and visual artifacts? |
| Legacy knowledge | What durable facts in archived knowledge should be curated forward? |

Legacy lanes should be skipped when there is no archive.

Sub-agents should report evidence, not write final lifecycle documents. A report should include:

- claim,
- source path or command,
- evidence type: code, test, config, runtime, legacy spec, journal, visual, knowledge,
- whether the claim describes current implementation or legacy intent,
- confidence,
- uncertainty or contradiction,
- suggested destination: `project/overview.md`, `project/architecture.md`, `project/product.md`, `project/testing.md`, `project/design.md`, `project/design-components/`, or `knowledge/*`.

### Synthesis

The main agent gathers the lane reports, resolves conflicts, and writes the final documents.

Expected outputs:

```text
.tenet/project/
  overview.md
  architecture.md
  product.md
  testing.md
  design.md
  design-components/     # optional during initial bootstrap

.tenet/knowledge/
  <curated concern-oriented files>
```

`project/design.md` is required for every project. It is not a generic software design document and not a duplicate of `architecture.md`. It describes the public or user-facing experience: interaction flows, operational surfaces, language and feedback, accessibility and responsiveness when relevant, visual system when relevant, and anti-patterns that would make the project feel wrong. Internal API ergonomics belong here only when the API is itself the user-facing product surface.

`project/design-components/` is useful but can be created later if the first bootstrap does not have enough concrete component or interaction-surface evidence. Creating and maintaining it will also require later updates to Tenet phase documents so jobs know to read, reuse, and update accepted examples.

Bootstrap should be idempotent. Running it again should refresh the same baseline files rather than inventing a new document set or reconstructing historical `runs/`.

### Sub-Agent Requirement

Tenet targets Claude Code, Codex, and OpenCode, and all three support parallel sub-agents. Context bootstrap should rely on that capability.

If sub-agents are unavailable, bootstrap should stop and explain that the phase requires sub-agent support. A degraded main-agent-only mode may be allowed only with explicit user approval. In that mode, the main agent must first write the lane plan and must persist intermediate findings to disk before each investigation lane so the work can survive context compaction or session restart.

### Relationship To Migration And Cleanup

Migration and bootstrap can be run together, but they are not the same operation.

- Migration mechanically preserves legacy evidence under `archive/legacy-v1/` and prepares old `.tenet/` trees for the lifecycle layout.
- Bootstrap synthesizes the current project baseline under `project/` and curated reusable memory under `knowledge/`.
- Document cleanup is later lifecycle maintenance for projects that already have usable `project/` docs but have accumulated noisy runs, research, or knowledge.

For V1, context bootstrap plus migration may be enough. A separate document-cleanup phase should be introduced only when there is a clear recurring maintenance workflow that is not covered by bootstrap.

## Migration Process

Migration is an explicit maintenance workflow for existing `.tenet/` trees. It is not normal job execution, and it should not be triggered silently while active Tenet jobs are depending on existing paths.

This section describes how legacy documents are archived and prepared for context bootstrap.

### Migration Goals

A complete migration plus bootstrap pass should produce:

```text
.tenet/
  project/              # synthesized project doctrine
  knowledge/            # curated reusable memory
  runs/                 # future run-local work; usually empty at migration time
  archive/legacy-v1/    # mechanically preserved old document evidence
```

The migration should not:

- reconstruct every historical feature as a fake `runs/<run>/` directory,
- copy old `knowledge/` forward unchanged,
- leave old evidence directories active at top level after full tool support exists,
- move live runtime SQLite state into archive,
- delete evidence during the first migration pass.

### 1. Snapshot And Inventory

Before moving documents, inventory the existing `.tenet/` tree and current runtime references:

- active and pending jobs in SQLite,
- `artifact_paths` stored on registered jobs,
- top-level document directories and root files,
- tracked vs ignored state,
- large generated artifacts,
- obvious duplicate or superseded files.

Any path currently referenced by an active job's `artifact_paths` must remain readable until the job is finished or the job is safely re-registered with new paths. Today, Tenet has exact path references but no general-purpose document-path rewrite tool, so migration should prefer waiting for active runs to finish.

### 2. Mechanical Archive

Create `.tenet/archive/legacy-v1/` and copy the old document evidence there exactly enough that future agents and humans can inspect historical state.

Typical archive inputs:

```text
.tenet/DESIGN.md
.tenet/bootstrap/
.tenet/decomposition/
.tenet/harness/
.tenet/interview/
.tenet/journal/
.tenet/knowledge/
.tenet/spec/
.tenet/status/
.tenet/steer/
.tenet/visuals/
```

Do not archive live `.tenet/.state/` as documentation. `.tenet/state-snapshot/` remains the portable runtime-state lane.

The archive is cold evidence. `compile_context` should ignore it by default and only mention that archived legacy evidence exists. Agents may search it explicitly when investigating history or provenance.

After Stage B, `.tenet/harness/current.md` should exist only under the archive. Bootstrap or migration may read it as legacy evidence, but future Tenet phases should not ask agents to update it and should not preserve it as an active compatibility mirror.

### 3. Run Bootstrap Synthesis For `project/`

`project/` is synthesized, not copied. The synthesis should be live-scan-first: current code, tests, config, and runtime behavior are stronger evidence than old desired-state specs.

Suggested synthesis sources:

| Target | Main evidence |
|---|---|
| `project/overview.md` | repository tree, current package/build files, config files, live module boundaries |
| `project/architecture.md` | current code structure, runtime boundaries, data model, integration contracts, persistence model |
| `project/product.md` | implemented product behavior, current UI/API behavior, tests and fixtures that express behavior |
| `project/testing.md` | actual test files, package scripts, CI config, current eval commands, working local verification paths |
| `project/design.md` | current public/user-facing experience, interaction flows, operational surfaces, copy/feedback rules, accessibility/responsiveness, UI/visual doctrine when applicable |
| `project/design-components/` | reusable implemented UI or interaction-surface patterns and accepted examples that match the current product |

Legacy documents remain useful, but mainly as secondary evidence:

- specs, decompositions, and interviews can recover intent, long-term product direction, and constraints;
- harnesses, status files, and journals can recover operational lessons and verification gotchas;
- old design docs and visuals can recover accepted design decisions only when they still match the implemented product;
- archived knowledge can be deduplicated into durable top-level `knowledge/` files.

Final `project/**` documents should not include migration commentary, provenance sections about legacy conflicts, or "archive said X but code says Y" notes. They should state the resolved current project baseline.

When legacy docs conflict:

- prefer current code and passing tests for implemented behavior,
- prefer current package scripts, config, and CI for verification behavior,
- use legacy intent only when it is not contradicted by the current project,
- preserve useful historical lessons in `knowledge/`, not `project/`,
- turn unresolved important ambiguity into a user question or follow-up task instead of encoding it as project doctrine.

### 4. Curate Top-Level `knowledge/`

After migration, `.tenet/knowledge/` should contain curated reusable memory only.

Legacy `.tenet/knowledge/*` is first preserved under `.tenet/archive/legacy-v1/knowledge/`. Then a synthesis pass promotes only durable, reusable facts into top-level concern-oriented files such as:

```text
.tenet/knowledge/worker-queue.md
.tenet/knowledge/transcript-sync.md
.tenet/knowledge/frontend-curation.md
```

Do not preserve raw `research-*` accumulation at top level unless it has been merged, deduplicated, and still matters to future work. Raw or run-specific research belongs under a future `runs/<run>/research/`.

### 5. Start `runs/` From The Migration Point

Historical feature docs stay in `archive/legacy-v1/`. Do not backfill every old spec/decomposition/journal group into `runs/`; the result looks authoritative but is usually heuristic and misleading.

`runs/` starts with future work. The only exception is an unfinished active feature: if the user explicitly chooses to continue it under the new layout, create one run directory for that active feature and register future jobs with exact run-local `artifact_paths`.

### 6. Compatibility Stages

There are two migration stages because current Tenet tools still know the old top-level layout.

**Stage A: tool-compatible migration**

- Add `project/`.
- Create `archive/legacy-v1/`.
- Curate top-level `knowledge/` if safe.
- Keep old top-level artifact directories readable while current tools and active jobs may still use them.
- Do not claim the old top-level directories are inactive unless `compile_context`, skill instructions, and job registration have moved to the lifecycle layout.

**Stage B: full lifecycle migration**

- New jobs use `runs/<run>/` and exact run-local `artifact_paths`.
- `compile_context` reads `project/*`, run-local artifacts, top-level curated `knowledge/*`, and ignores `archive/` by default.
- Old top-level evidence directories exist only under `archive/legacy-v1/`, except compatibility/runtime lanes such as `status/` and `state-snapshot/` if still supported.

Stage B is the state that avoids confusing future agents. Stage A is the safe bridge while the implementation still supports legacy paths.

## `tenet_compile_context` Contract

`compile_context` should use the runtime job UUID only to find the job row. It should not derive document paths from the UUID.

The job row should continue to carry exact `artifact_paths`. For a run-local layout, those paths look like:

```json
{
  "spec": ".tenet/runs/2026-06-10-production-readiness/spec.md",
  "harness": ".tenet/runs/2026-06-10-production-readiness/harness.md",
  "scenarios": ".tenet/runs/2026-06-10-production-readiness/scenarios.md",
  "interview": ".tenet/runs/2026-06-10-production-readiness/interview.md",
  "decomposition": ".tenet/runs/2026-06-10-production-readiness/decomposition.md"
}
```

### Run Identity In Job Params

Run identity should be stored additively in each job's SQLite `params`, next to existing fields such as `feature`, `dag_id`, and `artifact_paths`.

Use human-readable run fields rather than runtime UUIDs:

```json
{
  "feature": "production-readiness",
  "run_slug": "2026-06-10-production-readiness",
  "run_path": ".tenet/runs/2026-06-10-production-readiness",
  "artifact_paths": {
    "spec": ".tenet/runs/2026-06-10-production-readiness/spec.md",
    "harness": ".tenet/runs/2026-06-10-production-readiness/harness.md",
    "scenarios": ".tenet/runs/2026-06-10-production-readiness/scenarios.md",
    "interview": ".tenet/runs/2026-06-10-production-readiness/interview.md",
    "decomposition": ".tenet/runs/2026-06-10-production-readiness/decomposition.md"
  }
}
```

`artifact_paths` remains the exact authority for document loading. `run_slug` and `run_path` are for grouping, status display, run-local evidence listing, cleanup, retry, and recovery flows.

Do not add a separate `runs` DB table in V1. A first-class run table should wait until Tenet needs independent run lifecycle state, run status, run ownership, or run queries beyond the jobs table.

Legacy jobs may omit `run_slug` and `run_path`.

Recommended context inclusion:

Inline by default:

- job assignment,
- `project/overview.md`,
- `project/architecture.md`,
- `project/product.md`,
- `project/testing.md`,
- `project/design.md`,
- run-local `spec.md`,
- run-local `scenarios.md`,
- run-local `harness.md`,
- run-local `decomposition.md` initially, with future extraction of only the relevant job section and related interfaces.

List by default, read selectively:

- `runs/<run>/journal/*`,
- `runs/<run>/research/*`,
- `runs/<run>/visuals/*`,
- `knowledge/*`,
- `project/design-components/*`.

Do not inline the entire run directory.

## Write Authority

Normal implementation jobs:

- may edit source files,
- may write run-local evidence under `runs/<run>/**`,
- may update run-local docs such as `harness.md` or `design.md`,
- must not edit `project/**`.

When a normal job discovers that `project/**` is missing, stale, or wrong, it should record the proposed update in its own run-local evidence, such as `runs/<run>/journal/` or another run-local note, and mention it in its final report. It should not directly promote that finding into project doctrine.

Doctrine/synthesis jobs:

- may edit `project/**`,
- may promote findings from `runs/<run>/research/` or `runs/<run>/journal/` into `knowledge/**`,
- should keep evidence notes in run-local or synthesis working material when needed; final `project/**` docs should remain current project doctrine rather than audit trails.

For V1, authorized `project/**` writes should go through explicit project-doctrine phases:

- context bootstrap,
- migration/bootstrap synthesis,
- document lifecycle cleanup when explicitly requested,
- direct user request to update project doctrine.

All of these phases should read the bootstrap/lifecycle phase instructions before writing `project/**`. A separate project-doctrine-update phase may be added later if bootstrap becomes too broad.

Eval should enforce this boundary. If a normal implementation, eval, spec, decomposition, or run-local harness job changes `.tenet/project/**` without explicit doctrine/bootstrap authorization, eval should fail. The job can modify its own `runs/<run>/**` documents and suggest upstream changes there.

## Design Components

`project/design.md` is required project doctrine for experience design. It should not become a generic Google-style engineering design doc for technical proposals. Technical design doctrine belongs in `project/architecture.md`; run-local proposal design belongs in `runs/<run>/design.md`, `spec.md`, or `decomposition.md`.

`project/design-components/` is a curated agent-facing design system.

It should not be a dump of every visual artifact. `runs/<run>/visuals/` contains explorations and revisions. `project/design-components/` contains accepted reusable patterns that match the implemented product or other concrete user-facing interaction surface.

The purpose of this directory is to reduce agent design drift. Different LLMs tend to create subtly different UI and interaction treatments even when given the same prose design rules. Concrete component examples give agents something specific to inspect and follow so they do not invent a new design system when the job should preserve the current one.

V1 should start with plain self-contained HTML examples plus references to the real implementation files. Do not duplicate framework source by default; framework copies can drift quickly. The real source remains authoritative for implementation details, while the HTML example makes the accepted design pattern easy for any agent to inspect.

Example:

```text
.tenet/project/design-components/
  README.md
  button.html
  card.html
  audio-player.html
  transcript-panel.html
  empty-state.html
```

Each component file should use realistic sample data, show the accepted interaction and visual pattern, and include a short implementation-reference section pointing to the real source files. Agents touching user-facing UI or interaction surfaces can list these files and read only the relevant examples.

Framework-native examples may be added later only when a project needs them:

```text
.tenet/project/design-components/react/
.tenet/project/design-components/svelte/
```

## Lifecycle Skill

A `tenet-document-lifecycle` skill should be responsible for context bootstrap, semantic cleanup, and migration planning.

The normal Tenet skill should perform the cheap bootstrap gate before entering ordinary job phases. When the gate fails, it should route to the lifecycle/bootstrap workflow rather than continuing with missing or unusable project doctrine.

Suggested workflow:

1. Inventory `.tenet/` mechanically with shell probes: counts, sizes, file types, tracked state, modified dates, and obvious broken references.
2. Identify likely global doctrine, run-local docs, raw evidence, generated artifacts, and stale or superseded material.
3. For bootstrap, spawn bounded sub-agents by investigation lane and require evidence-oriented reports.
4. For cleanup or migration, read representative and high-risk docs.
5. Infer current project doctrine from live project evidence first.
6. Propose a target structure or migration plan.
7. Ask before modifying files unless the user already requested the migration/bootstrap write.

The skill should clearly separate:

- mechanical facts,
- semantic inferences,
- recommendations,
- items needing user confirmation.

## Non-Goals For V1

- No automatic semantic audit tool.
- No mandatory generated `index.md`.
- No required end-of-run `summary.md`.
- No automatic deletion of old docs or generated artifacts.
- No immediate migration of existing `.tenet/spec`, `.tenet/decomposition`, `.tenet/interview`, `.tenet/journal`, or `.tenet/visuals`.
- No job-UUID-based document directories.
- No thin/stale scoring in the bootstrap gate.
- No legacy conflict commentary inside final `project/**` docs.

## Incremental Adoption Path

1. Add `project/` templates for new projects.
2. Add the pass/fail bootstrap gate to the Tenet skill.
3. Add context-bootstrap as a lifecycle phase that creates `project/` and curated `knowledge/` from live scans plus optional archive scans.
4. Add run-local artifact generation for new runs.
5. Keep top-level artifact directories as legacy fallbacks.
6. Continue storing exact `artifact_paths` on every registered job.
7. Teach `compile_context` to inline global `project/` docs plus exact run-local artifacts.
8. Keep `knowledge/` as curated global memory and move raw research into run-local `research/`.
9. Add document cleanup only if a recurring maintenance workflow remains after bootstrap and migration.

## Open Questions

No open questions for the current lifecycle shape.
