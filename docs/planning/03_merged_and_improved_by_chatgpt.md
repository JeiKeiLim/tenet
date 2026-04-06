# Long-Running AI Agent Plugin System

## Merged and Research-Backed Design v0.2

**Date**: 2026-04-03  
**Supersedes**: `01_initial_prd.md`, `02_adverserial_review_improvements.md`  
**Goal**: Turn the original idea into a concrete, research-backed design for a cross-platform plugin/runtime that supports long-running software delivery with human steering, durable artifacts, and bounded-risk autonomy.

---

## 1. Executive Summary

The original concept is directionally right: long-running agent work should be broken into small jobs, executed in fresh sessions, and coordinated through durable markdown artifacts rather than opaque memory.

The main changes in this merged design are:

1. Replace vague ideas like "stay under 50% context" with observable budgets: turn count, files touched, interfaces changed, and test scope.
1. Replace raw file loading with a **compiled working context** assembled per job from status, spec, interfaces, recent changes, steer messages, and only high-confidence knowledge.
1. Treat external memory as a risk surface, not automatically as truth. All agent-authored knowledge must carry provenance and confidence state.
1. Split delivery into **author** and **critic** roles for evaluation, while keeping mechanical checks deterministic and cheap.
1. Move ambiguity reduction earlier and make it artifact-driven, because benchmark evidence shows underspecified tasks and hidden acceptance criteria are a major failure mode for coding agents.
1. Formalize brownfield onboarding, steer handling, checkpoint/restart, and document schemas so the system is implementable rather than aspirational.

This version aims for **hours-long progress through many short, well-bounded sessions**, not one magical 12-hour uninterrupted context. Research and vendor guidance both point toward multi-session orchestration, context compaction, structured note-taking, and explicit artifact handoff as the more credible path.

---

## 2. What The Research Actually Supports

### 2.1 Long-running agents need session handoff artifacts

Anthropic’s guidance on long-running agents frames the core problem clearly: agents work across many context windows, each new session starts without direct memory, and progress depends on leaving artifacts for the next session. Their recommended pattern is an initializer plus coding sessions that make incremental progress and leave structured updates. This strongly supports the original markdown-first idea, but it also implies that session continuity must be designed explicitly, not assumed. [R1]

### 2.2 Raw context accumulation is a reliability problem

Anthropic’s context engineering guidance argues that context is finite, that long traces cause "context rot", and that long-horizon agents need compaction, structured note-taking, and selective retrieval. This backs the move away from "load these five files every time" toward a compiled working context per job. [R2]

### 2.3 Session memory and long-term memory should be separated

Google ADK distinguishes:

- `Session` and `State` for current-conversation working context
- `Memory` for searchable, cross-session information

That separation matters here. The system should not treat all markdown docs as one flat memory pool. Some documents are current working state; others are long-term memory; others are immutable reference artifacts. Mixing them increases drift risk. [R3], [R4]

### 2.4 Hidden or underspecified requirements are a major coding-agent failure mode

OpenAI’s SWE-bench analyses show two relevant things:

1. Hidden or overly specific tests can reject correct solutions.
1. Underspecified task statements materially damage evaluation quality.

That directly supports investing in stronger interview/spec artifacts, scenario-based acceptance criteria, and visible evaluation criteria. If humans cannot state the requirements clearly, long-running agents do not become more reliable by looping longer. [R5], [R6]

### 2.5 Evaluation should not rely only on the same agent’s own test imagination

Property-based testing frameworks such as `fast-check` and `Hypothesis` exist precisely because example-based tests depend on the test writer imagining the right edge cases. That limitation applies even more strongly to agent-written code and tests. This supports adding property-based checks where the domain permits them. [R7], [R8]

OpenAI’s "Let’s Verify Step by Step" also supports a broader principle: process-level verification outperforms coarse outcome-only supervision on complex reasoning. For this design, that suggests structured intermediate review is better than a single end-of-job "did it work?" judgment. [R9]

### 2.6 Scenario artifacts are a reasonable bridge from intent to implementation

Scenario-based design literature supports the use of concrete user scenarios because they help teams reflect, communicate intent, and reason about consequences more effectively than abstract requirement statements alone. This supports keeping scenarios and anti-scenarios as first-class planning artifacts. [R10]

### 2.7 What the research does not cleanly prove

The earlier draft referenced claims such as a universal "35-minute degradation wall" and specific lessons attributed to Manus. I did not find primary sources strong enough to keep those as hard design facts. This document therefore reframes them into a weaker, defensible position:

- Long sessions accumulate noise and stale reasoning.
- Checkpointing and compaction help.
- Exact thresholds should be treated as operational defaults to tune, not scientific constants.

---

## 3. Design Goals and Non-Goals

### 3.1 Goals

1. Support many-session autonomous delivery over hours with bounded risk.
1. Keep all key state human-readable, versionable, and portable across agent platforms.
1. Minimize context pollution through per-job compiled context.
1. Make spec drift, memory drift, and execution drift observable.
1. Support both greenfield and brownfield development.
1. Allow asynchronous human steering without collapsing the execution loop.

### 3.2 Non-goals

1. Perfect fully autonomous software delivery with no human intervention ever.
1. A single universal scoring formula for all projects.
1. One-shot whole-repo understanding for large brownfield systems.
1. Replacing source control, CI, or issue tracking systems.

---

## 4. Core Architecture

## 4.1 Artifact model

The system should use a dedicated project folder such as `.agent/` at repo root.

Suggested structure:

```text
.agent/
  charter.md
  status/
    current.md
    history.md
  interview/
    current.md
    decisions.md
    rejected-options.md
  spec/
    current.md
    scenarios.md
    anti-scenarios.md
    change-log.md
  harness/
    current.md
    policies.md
  planning/
    decomposition.md
    graph.json
    queues.md
  knowledge/
    project-overview.md
    <concern>.md
  steer/
    inbox.md
    processed.md
  jobs/
    JOB-001.md
    JOB-002.md
  runs/
    JOB-001/
      attempt-01.md
      critic-01.md
      eval-01.md
      checkpoint-01.md
  lessons/
    current.md
    archive.md
```

### 4.2 Artifact classes

Use four distinct classes of documents:

1. **Reference artifacts**: charter, approved scenarios, harness policies. These are authoritative until changed by an explicit process.
1. **Working-state artifacts**: current status, job files, checkpoints, steer inbox.
1. **Knowledge artifacts**: concern-specific implementation notes and interface summaries.
1. **Run artifacts**: per-attempt notes, critic findings, evaluation outputs, command/test summaries.

This separation follows the session/state/memory distinction from ADK and reduces accidental contamination between transient work and long-term memory. [R3], [R4]

### 4.3 Knowledge entry schema

Every agent-authored knowledge entry should use lightweight frontmatter or inline metadata:

```markdown
## Token refresh rotation
- confidence: implemented_and_tested
- source: code-observed
- files: [src/auth/tokens.ts, tests/auth/tokens.test.ts]
- last_verified_at: 2026-04-03
- owner_job: JOB-014

Refresh tokens are rotated on each successful use. The old token is invalidated immediately.
```

Allowed confidence values:

- `decision_only`
- `implemented_not_tested`
- `implemented_and_tested`
- `observed_from_existing_code`
- `superseded`

This confidence tagging is a **design inference**, not a direct research claim. It is justified by the research-backed separation of current context vs long-term memory and by the real risk of polluted external memory in long-running systems. [R2], [R3], [R4]

---

## 5. Lifecycle

## 5.1 Phase 0: Brownfield or greenfield detection

If the request targets an existing codebase, run staged onboarding:

### Stage 0a: Skeleton scan

Capture:

- directory map
- language/runtime mix
- package managers and dependency manifests
- CI/test commands
- deployment/config entry points

Write `knowledge/project-overview.md`.

### Stage 0b: Targeted deep scan

Only inspect subsystems relevant to the requested work. For example, an OAuth request scans auth middleware, session models, routes, and config.

Write concern docs such as `knowledge/auth.md`.

### Stage 0c: Interface extraction

Record relevant public contracts:

- API routes
- exported service boundaries
- database models
- events/webhooks
- feature flags/config surfaces

Write summarized interfaces into the relevant concern docs and `planning/decomposition.md`.

This staged approach is more realistic than full-repo semantic understanding up front and aligns with just-in-time context retrieval guidance. [R2]

## 5.2 Phase 1: Crystallization

The interview phase should end only when enough artifacts exist, not when the user "feels done."

Use three scored dimensions:

| Dimension | Weight | Full-credit artifact |
|---|---:|---|
| Goal clarity | 0.4 | acceptance scenarios for the primary flow |
| Constraints | 0.3 | harness constraints and explicit boundaries |
| Success criteria | 0.3 | measurable checks or scenario-verifiable outcomes |

Recommended gate:

- proceed when weighted clarity score `>= 0.8`
- otherwise continue interview and artifact creation

### Required outputs before execution

1. `charter.md`: one-page statement of purpose, target user, and value.
1. `spec/current.md`: scope, out-of-scope, acceptance criteria.
1. `spec/scenarios.md`: primary success scenarios.
1. `spec/anti-scenarios.md`: explicit failure patterns to avoid.
1. `harness/current.md`: safety, tool, and repo constraints.

Scenario and anti-scenario artifacts are important because benchmark evidence shows underspecified tasks are a first-order failure mode for agentic coding. [R5], [R6], [R10]

## 5.3 Phase 2: Planning and decomposition

Instead of asking "will this fit in 50% of context?", decompose work into jobs that satisfy observable budgets.

Default job budget:

- `max_files_touched: 5`
- `max_public_interfaces_changed: 2`
- `max_new_tests: 10`
- `warning_turns: 25`
- `hard_turn_limit: 40`
- `max_estimated_elapsed_minutes: 30`

Each job file should include:

```markdown
# JOB-014

## Goal
Add PKCE verifier generation and validation to OAuth login flow.

## Inputs
- spec refs
- relevant interface refs
- steer refs

## Outputs
- code changes
- tests
- knowledge updates

## Dependencies
- JOB-009

## Constraints
- no schema changes
- no UI work

## Acceptance checks
- ...
```

The output should be a DAG with leaf jobs small enough to be restarted cheaply.

## 5.4 Phase 3: Execution loop

Per job:

```text
compile context -> author run -> mechanical eval -> critic eval -> integrate learnings -> complete or retry
```

### Step A: Compile context

Do not load raw artifact folders into the author session.

Generate a single `runs/<job>/compiled-context.md` from:

1. job file
1. relevant spec excerpts
1. relevant interface excerpts
1. current status summary
1. steer items tagged to this job
1. high-confidence knowledge entries only
1. current lessons
1. last failed attempt, if retrying

### Step B: Author run

The author session:

- implements the change
- writes or updates tests
- updates knowledge artifacts
- emits a concise run note

### Step C: Mechanical eval

Always run deterministic checks first:

- build
- lint/format
- type-check
- targeted tests
- broader regression tests when cheap enough

If the project stack supports it, add property-based checks for critical pure logic, serialization, parsing, permissions, and state transitions. This is especially useful because example-based tests depend on the test writer foreseeing edge cases. [R7], [R8]

### Step D: Critic eval

Run a separate critic session with a fresh context containing:

- job goal
- relevant spec and scenarios
- harness constraints
- diff summary or changed files
- mechanical eval results

Do **not** include:

- the author’s chain of reasoning
- the author’s self-justification
- raw knowledge docs unless specifically needed

The critic should:

1. search for spec mismatches
1. search for anti-scenario matches
1. propose missing tests
1. flag doc-code mismatches
1. flag risky interface changes

This author/critic split is a **design inference** supported indirectly by process-supervision research and by the weakness of single-author example-based testing, not by a single paper proving this exact pipeline. [R7], [R9]

### Step E: Retry or complete

If eval fails:

- append findings to `runs/<job>/eval-XX.md`
- keep the failure trace in the retry context for the next attempt
- do not promote failed conclusions into long-term lessons automatically

If eval passes:

- promote validated learnings into `knowledge/*.md`
- update `status/current.md`
- mark job complete

---

## 6. Context Compilation

This is the most important new concrete mechanism in the design.

## 6.1 Compiler pipeline

```text
raw artifacts
  -> relevance filter
  -> recency filter
  -> interface extraction
  -> confidence filter
  -> steer merge
  -> token budget trim
  -> compiled-context.md
```

### 6.2 Rules

1. Load full text only for artifacts directly needed by the job.
1. Prefer summaries plus file handles over dumping long histories.
1. Exclude `decision_only` knowledge unless no stronger source exists.
1. Always include unresolved contradictions.
1. Always include the most recent failed attempt for the same job.
1. Prefer interface summaries over entire source files during planning.

This follows Anthropic’s guidance to keep context tight, informative, and incrementally retrieved rather than naively accumulated. [R2]

---

## 7. Checkpointing and Session Refresh

Long jobs should restart before they become noisy.

Recommended policy:

- soft warning at 25 turns
- hard checkpoint at 40 turns
- immediate checkpoint if the agent rereads the same files repeatedly or cannot state next action clearly

Checkpoint artifact should include:

- what changed
- what remains
- open questions
- commands/tests already run
- known failures
- next recommended step

This is supported by long-horizon context-compaction guidance, though the exact turn numbers are operational defaults that should be tuned empirically. [R1], [R2]

---

## 8. Evaluation Model

## 8.1 Typed checks

Split the earlier vague "cascade check" into three explicit checks:

### A. Document-to-document alignment

Examples:

- interview vs spec
- spec vs harness
- scenario vs anti-scenario coverage

Trigger:

- whenever the spec, harness, or scenarios change

### B. Code-to-document alignment

Examples:

- knowledge doc vs changed code
- interface summary vs actual exports
- status summary vs actual completed jobs

Trigger:

- after each completed job

### C. Trajectory-to-purpose alignment

Examples:

- are recent jobs still advancing the charter?
- did the queue get captured by low-value cleanup?
- are we drifting into unapproved scope?

Trigger:

- every N jobs, or after any major steer directive

## 8.2 Evaluation rubric

Each completed job should be graded on:

- correctness
- regression risk
- spec compliance
- scenario satisfaction
- anti-scenario avoidance
- documentation fidelity
- interface stability

Do not compress these into a single opaque score. Keep a per-dimension pass/warn/fail outcome.

---

## 9. Async Human Steering

The original instinct was good: steer should usually be context, not a synchronous interrupt.

## 9.1 Message classes

### Context

New information or constraints to consider later.

Example:

- "Users are complaining about slow page loads on mobile."

### Directive

A backlog, priority, or scope change that should affect planning.

Example:

- "Stop admin work and prioritize onboarding."

### Emergency

Immediate halt or containment signal.

Example:

- "The migration script is corrupting production data."

## 9.2 Delivery rules

1. Context messages are merged into compiled context for affected pending jobs.
1. Directives update queue ordering and may reopen spec/harness alignment.
1. Emergencies pause relevant jobs immediately and create a blocking incident job.

## 9.3 Tagging

The orchestrator should tag steer items with affected concerns and job IDs. Untagged steer messages go to a triage step before entering job contexts.

---

## 10. Harness Design

The harness is not just a rules file. It is the operational contract between the orchestrator and each session.

Minimum harness fields:

```markdown
allowed_tools:
  - read
  - edit
  - test

forbidden_paths:
  - infra/prod/
  - migrations/legacy/

requires_approval_for:
  - schema changes
  - secret handling
  - dependency upgrades

quality_gates:
  - typecheck
  - targeted tests
  - doc sync for touched concern docs

job_budgets:
  max_files_touched: 5
  hard_turn_limit: 40
```

The Anthropic harness work strongly supports distinct initialization and execution prompts plus structured environment artifacts. This document extends that into per-job policies and escalation rules. [R1]

---

## 11. Concrete MVP Scope

If building this system incrementally, the first shippable version should include:

### MVP-1

1. artifact store
1. interview/spec/harness templates
1. staged brownfield scan
1. job DAG creation
1. compiled-context generation
1. author execution loop
1. mechanical eval
1. status and knowledge updates

### MVP-2

1. critic session
1. typed alignment checks
1. steer inbox with classification
1. checkpoint/restart
1. confidence-tagged knowledge writes

### MVP-3

1. property-based test generation hooks
1. richer brownfield interface extraction
1. cross-job risk scoring
1. historical analytics for decomposition quality

---

## 12. Key Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Memory drift | bad agent-authored docs become false ground truth | provenance + confidence tags + code/doc alignment checks |
| Spec drift | long runs optimize for local tasks, not user value | trajectory-to-purpose checks + steer directives |
| Oversized jobs | retries become expensive and noisy | observable job budgets + checkpointing |
| Hidden acceptance criteria | agent "fails correctly" | require scenario artifacts and visible acceptance checks |
| Brownfield over-scanning | token/cost blow-up | staged onboarding and concern-scoped scans |
| Self-validation loops | author misses own blind spots | critic session + property-based checks where applicable |

---

## 13. Recommended Positioning

The system should not be marketed internally as "12 hours of autonomous coding in one run." That framing over-promises.

A more accurate description is:

> A markdown-native orchestration layer for many-session agent work that converts ambiguous requests into executable artifacts, runs bounded jobs with compiled context, and preserves continuity through explicit handoff artifacts.

That description is more defensible and better aligned with how current agent systems actually work in production.

---

## 14. Final Recommendation

Keep the original philosophy:

- markdown-native
- fresh sessions
- durable docs
- human steering

But operationalize it around:

- compiled context instead of raw file loading
- artifact-gated planning instead of intuition-based readiness
- observable job budgets instead of token guesses
- author/critic evaluation instead of self-approval
- provenance-aware memory instead of flat knowledge accumulation

That combination is both stronger than the original PRD and better supported by current public research and vendor engineering guidance.

---

## References

- [R1] Anthropic, *Effective harnesses for long-running agents* (2025): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [R2] Anthropic, *Effective context engineering for AI agents* (2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [R3] Google ADK, *Technical Overview* (accessed 2026-04-03): https://adk.dev/get-started/about/
- [R4] Google ADK, *Introduction to Conversational Context: Session, State, and Memory* (accessed 2026-04-03): https://adk.dev/sessions/
- [R5] OpenAI, *Introducing SWE-bench Verified* (2024, updated 2025): https://openai.com/index/introducing-swe-bench-verified/
- [R6] OpenAI, *Why SWE-bench Verified no longer measures frontier coding capabilities* (2026-02-23): https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
- [R7] fast-check, *Why Property-Based Testing?* (accessed 2026-04-03): https://fast-check.dev/docs/introduction/why-property-based/
- [R8] Hypothesis, official site and docs (accessed 2026-04-03): https://hypothesis.works/ and https://hypothesis.readthedocs.io/
- [R9] Lightman et al., *Let’s Verify Step by Step* (2023): https://arxiv.org/abs/2305.20050
- [R10] Carroll, *Five reasons for scenario-based design* (2000): https://doi.org/10.1016/S0953-5438(00)00023-0
