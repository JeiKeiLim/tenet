# Phase 2: Spec and Harness Generation

Crystallize the project requirements into strict, actionable files. This phase ensures the agent has a source of truth before building.

## 0. Pre-Spec Research (mandatory)

Before writing the spec, conduct comprehensive research on the technologies, APIs, and approaches that will be used. This prevents spec'ing features that are infeasible or choosing suboptimal approaches.

**What to research:**
- Every external API, SDK, or service mentioned in the interview
- Framework-specific patterns for the chosen tech stack (e.g., Next.js App Router vs Pages Router, auth patterns)
- Database design patterns for the data model
- Deployment constraints and infrastructure requirements
- Security best practices for the specific tech stack
- Third-party library compatibility and maintenance status

**How to research:**
1. Use `WebSearch` to find official documentation, guides, and known issues
2. Use `WebFetch` to read specific documentation pages
3. Read existing codebase patterns (brownfield projects)
4. Cross-reference findings with interview decisions

**Save ALL research results:**
- Write raw or run-specific findings to `.tenet/runs/{run_slug}/research/{topic}.md`
- Include: what was researched, key findings, limitations discovered, recommended approach
- Tag with `[scanned-not-verified]` confidence level
- Promote only durable reusable facts to top-level `.tenet/knowledge/` via `tenet_update_knowledge(type="knowledge", title="{concern}")`
- These become reference material for the current run; curated knowledge becomes reference material for future runs

**Example pre-spec research:**
- `.tenet/runs/{run_slug}/research/nextjs-auth-patterns.md` -> How to implement auth with the chosen stack, session management options
- `.tenet/runs/{run_slug}/research/stripe-connect-api.md` -> API limits, webhook requirements, test mode setup
- `.tenet/runs/{run_slug}/research/postgresql-jsonb-indexing.md` -> Performance characteristics for the planned schema design

**Do NOT skip this step.** Writing a spec without researching the technologies leads to specs that can't be implemented, or implementations that use the wrong patterns.

**Ground every codebase claim in real files.** When the spec references the existing project (a module, an API, a table, current behavior, a config value), verify it by reading the actual code and cite the file path inline (e.g. `src/auth/session.ts`). Do not assert how the codebase works from memory or assumption — an un-cited or fabricated codebase claim becomes a silent landmine at execution time, when the worker finds the code doesn't match the spec. If you cannot verify a claim against the real project, mark it `[unverified]` and resolve it before the spec passes the readiness gate. The readiness gate treats un-cited/invented codebase claims as a blocker. (Greenfield runs have no existing code to cite — this applies only to claims about code that should already exist.)

## 1. Exact File Paths
CRITICAL: Write all run-local artifacts under `.tenet/runs/{run_slug}/` (paths below). Run artifacts do not live anywhere else.

Use the same `{feature}` slug established during the interview phase. `{date}` is today's ISO date (YYYY-MM-DD), and `run_slug` is `{date}-{feature}`.

- **RUN PATH**: `.tenet/runs/{run_slug}/`
- **SPEC**: `.tenet/runs/{run_slug}/spec.md`
- **HARNESS**: `.tenet/runs/{run_slug}/harness.md`
- **SCENARIOS**: `.tenet/runs/{run_slug}/scenarios.md`
- **INTERVIEW**: `.tenet/runs/{run_slug}/interview.md`
- **RESEARCH**: `.tenet/runs/{run_slug}/research/`

Read `.tenet/project/overview.md`, `.tenet/project/architecture.md`, `.tenet/project/product.md`, `.tenet/project/testing.md`, and `.tenet/project/design.md` before writing run-local artifacts. Normal spec/harness work may suggest project doctrine updates in the run journal, but it must not directly edit `.tenet/project/**`.

## 2. Spec Requirements (`.tenet/runs/{run_slug}/spec.md`)

### 2.1 Front matter (REQUIRED)

The spec MUST begin with a YAML front-matter block declaring the delivery mode:

```yaml
---
delivery_mode: autonomous   # or: agile
---
```

- **`autonomous`** (default): the agent runs the full autonomous loop end-to-end with no mid-run user checkpoints. Decomposition produces today's component DAG (`[auth] · [posts] · ... → [assemble] → [eval]`).
- **`agile`**: the agent pauses after the upfront mockup (initial plan-checkpoint) and after each slice's eval (use-checkpoint) for user review. Decomposition produces a sliced DAG. Picking agile REQUIRES the `## Slice plan` section described in section 2.3.

If the field is missing, treat as `autonomous` for backward compatibility.

For Full mode runs with an interview transcript, copy `delivery_mode` from the transcript's `## Delivery Mode Decision`. If that section is missing, malformed, or does not match the intended front matter, stop spec generation and return to `phases/01-interview.md`. Do not silently default in Full mode.

The field is named `delivery_mode` (not `mode`, not `execution_mode`) because both names are already taken: `mode` is the scale-adaptive crystallization mode (`full | standard | quick | unset`) and `execution_mode` is the eval critic dispatch order (`parallel | sequential`). See `docs/planning/14_agile_mode.md` for the full agile-mode design.

### 2.2 Required sections

The spec must include:
- **Purpose**: 1 to 3 sentence project goal from the interview.
- **Tech Stack**: Confirmed choices with specific versions.
- **API Endpoints**: Table with Method, Path, Auth, and Description.
- **Database Schema**: Table per entity with Column, Type, and Constraints.
- **Design Direction**: Explicit reference to the chosen mockup/prototype in `.tenet/runs/{run_slug}/visuals/` and the applicable doctrine in `.tenet/project/design.md`. In agile mode, the first spec draft may mark this as pending until `phases/03-visuals.md` produces final-product and slice artifacts; update this section before readiness validation.
- **Auth Flow**: Step by step numbered list.
- **Success Criteria**: Numbered, measurable, and testable outcomes.
- **Out of Scope**: List of features or behaviors the project will NOT implement.
- **Slice Plan**: REQUIRED when `delivery_mode: agile`. OMIT when `autonomous`. See section 2.3.

### 2.3 Slice Plan section (agile only)

When `delivery_mode: agile`, append a `## Slice plan` section to the spec. Slices are **additive**: slice N = slice N-1 + new capability. Each slice MUST end in a runnable + eval-passing application state — the user has to be able to actually use it at the use-checkpoint.

A slice = **one user-facing capability + everything needed to make it usable**. The planner is allowed and expected to bundle dependent sub-features when omitting them would leave the user with nothing to use (e.g., login alone is meaningless without signup, so slice 1 = login + signup).

Format:

```markdown
## Slice plan

Total slices: N

### Slice 1: <short name>
- **Adds**: <user-facing capability this slice delivers>
- **Bundled with**: <dependent sub-features needed to make this slice usable on its own; "none" if the capability stands alone>
- **User can**: <one-sentence description of what the user can actually do at the use-checkpoint>
- **Out of slice**: <features explicitly deferred to later slices>

### Slice 2: <short name>
- **Adds**: <new capability on top of slice 1>
- **Bundled with**: <…>
- **User can**: <…>
- **Out of slice**: <…>

(continue for each slice)
```

Slice plan rules:
- Order slices by user value, not technical convenience. Slice 1 should be the smallest thing the user wants to see working.
- Do NOT split a slice across multiple checkpoints. Every slice ends at a use-checkpoint.
- Pre-work that is not user-visible (foundational refactors, schema migrations) does not get its own slice; it is bundled into the first slice that needs it.
- The plan is the bigger picture upfront, but it is allowed to evolve via redirects at use-checkpoints.

## 3. Harness Requirements (`.tenet/runs/{run_slug}/harness.md`)
Write a run-specific quality and acceptance contract derived from the run spec plus `.tenet/project/testing.md` and other relevant project doctrine:
- **Formatting & Linting**: Specify tools like `ruff`, `eslint`, or `prettier`.
- **Testing**: Define framework and coverage targets.
- **Architecture Rules**: Add project-specific structural constraints.
- **Code Principles**: Append project-specific values to the defaults.
- **Danger Zones**: List paths that must never be modified.
- **Iron Laws**: Define project invariants, such as mandatory password hashing.
- **Project Doctrine Boundary**: State that normal implementation jobs must not edit `.tenet/project/**`; proposed doctrine updates belong in `.tenet/runs/{run_slug}/journal/`.

## 4. Scenarios (`.tenet/runs/{run_slug}/scenarios.md`)
Define success and failure shapes:
### Scenarios (Success)
1. [User story with concrete steps and expected outcome]
### Anti-Scenarios (Failure)
1. [Concrete failure mode to prevent]

## 5. Validation Checklist
Verify these before proceeding:
- [ ] `.tenet/runs/{run_slug}/spec.md` exists with the YAML front matter (`delivery_mode: autonomous | agile`) and all required sections.
- [ ] If `delivery_mode: agile`, the `## Slice plan` section is present and lists at least 2 slices, each with `Adds`, `Bundled with`, `User can`, and `Out of slice`.
- [ ] If `delivery_mode: autonomous` (or missing), the `## Slice plan` section is absent.
- [ ] `.tenet/runs/{run_slug}/harness.md` exists and is tailored to this run.
- [ ] `.tenet/runs/{run_slug}/scenarios.md` has 3+ scenarios and 3+ anti-scenarios.
- [ ] If the project is UI-facing, game/canvas-based, visual, TUI, CLI workflow-oriented, API workflow-oriented, or otherwise user-interactive, required artifacts from `phases/03-visuals.md` exist in `.tenet/runs/{run_slug}/visuals/` and the spec references them.
- [ ] Harness danger zones are populated.

**Do NOT proceed to decomposition until all three files are written and this checklist passes.**

## 6. Implementation Readiness Gate (hard block before decomposition)

After the checklist above passes, run `tenet_validate_readiness` with the exact artifact paths you just wrote. This is a **hard gate** — decomposition MUST NOT start until it passes.

```json
{
  "feature": "{feature}",
  "artifact_paths": {
    "spec": ".tenet/runs/{run_slug}/spec.md",
    "harness": ".tenet/runs/{run_slug}/harness.md",
    "scenarios": ".tenet/runs/{run_slug}/scenarios.md",
    "interview": ".tenet/runs/{run_slug}/interview.md"
  }
}
```

If an optional artifact does not exist, pass `null` for that key rather than omitting it silently. Do not rely on Tenet to guess the current spec from `{feature}` alone; feature-only lookup exists only as a compatibility fallback and may warn.

### What readiness validates
A fresh agent reads spec + harness (+ scenarios + interview) and scores 8 categories:

1. **Spec sufficiency** — acceptance criteria concrete enough for tests; error/retry policies specified.
2. **Research & prior art** — library/algorithm choices made and investigated; gotchas noted.
3. **Interface contracts** — internal API/event/DB shapes pinned; third-party contracts understood.
4. **External service access** — credentials for services the agent CALLS (LLM keys, payment sandboxes, webhook secrets). NOT for services the feature itself implements.
5. **Environment & runtime** — app start command, env vars, services, ports, health-check.
6. **Test data & fixtures** — seed data the agent cannot synthesize (real PDFs, sandbox users).
7. **Test strategy** — per layer (unit/integration/e2e) declared as live/sandboxed/mocked/skipped with reason; e2e surface declared as browser UI, visual/canvas/game, CLI, API, library, or not applicable (the interaction-e2e critic then applies agent-driven probing to whichever is declared — Playwright for browser, shell for CLI/API/library, so keep it enabled for non-UI projects); Playwright Layer 2 declared as required/optional/skipped with reason; non-UI verification (logs/metrics/DB assertions) for async/background surfaces.
8. **Dependencies & tooling** — libs/runtimes installable; build/test commands runnable.

### How to resolve a failing readiness check
For each returned blocker, pick ONE:
- **Supply the info** — edit spec/harness to add the missing detail, then re-run `tenet_validate_readiness`.
- **Ask the user** — via `tenet_add_steer` or interactive prompt. Do not guess credentials, callback URLs, or external service contracts.
- **Explicit mock with reason** — write a "Mocked because…" note into the spec for that layer, then re-run. The validator accepts explicit mocks but flags cases where every test layer is mocked.

### What NOT to do
- Do NOT create a `.tenet/testing/` directory or separate readiness artifact. Blockers are resolved by editing the existing spec/harness.
- Do NOT silently continue if readiness fails. `passed: false` is a hard block.
- Do NOT re-run clarity validation here — clarity is a separate, upstream gate.

### Also decides: eval execution mode
In addition to pass/fail, the readiness verdict answers **one more question**: do this feature's tests share mutable state (DB rows, sessions, rate limits, ports, files, Playwright lock dirs)?

- If yes → verdict sets `eval_parallel_safe = false`. Tenet will later serialize the configured critics (code → test → playwright by default, in roster order) instead of running them in parallel. This prevents false failures from contention on shared state.
- If no → verdict sets `eval_parallel_safe = true`. Critics run in parallel (today's behavior).

The verdict is persisted to the config table keyed by feature (`eval_parallel_safe:{feature}`) and consumed by `tenet_start_eval` automatically. No extra orchestration step needed. If the verdict is missing (e.g., quick mode skipped readiness), the eval tool defaults to **sequential** as a safe fallback.
