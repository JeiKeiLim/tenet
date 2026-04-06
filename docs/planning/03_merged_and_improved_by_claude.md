# Tenet: Long-Running AI Agent Plugin System

## Research-Backed Design Specification

**Version**: 0.3 (Merged & Improved)
**Date**: 2026-04-03
**Purpose**: A cross-platform AI agent plugin enabling 12-hour autonomous development cycles with human steering, structured documentation, and recursive task decomposition.
**Target platforms**: Claude Code, OpenAI Codex, OpenCode (and any agent supporting SKILL.md / AGENTS.md conventions)

**Lineage**: This document merges the initial PRD (v0.1) with the adversarial review (v0.2), validates all claims against published research, corrects unverifiable citations, and adds concrete implementation details where the originals were abstract.

-----

## 0. Research foundation and corrections

Before presenting the design, we address the empirical basis. Several claims from the original documents have been verified, corrected, or strengthened.

### 0.1 Error compounding — verified

The claim "95% per-step accuracy over 20 steps yields 36% end-to-end success" is correct mathematics (0.95^20 ≈ 0.358). It is not from a specific paper but is a straightforward application of the chain rule of independent probabilities, widely cited in agent reliability discussions.

Zylos Research (2026) provides additional data: **doubling task duration quadruples the failure rate** — a non-linear, roughly quadratic degradation curve. They also identify task duration as **doubling every 7 months** in frontier agent systems, projecting 8-hour autonomous workdays by late 2026 ([source](https://zylos.ai/research/2026-01-16-long-running-ai-agents)).

The compounding error problem is further substantiated by:
- **ReAct** (Yao et al., 2023) — documents error compounding in reasoning-action loops
- **Reflexion** (Shinn et al., 2023) — proposes reflection as mitigation for error accumulation
- **"Towards a Science of AI Agent Reliability"** (2026, arXiv:2602.16666) — finds that rising benchmark accuracy yields only small improvements in operational reliability

> **Design implication**: The system MUST minimize the number of sequential steps per job. Fresh sessions per job is not optional — it is the primary defense against compounding.

### 0.2 The 35-minute degradation wall — verified with nuance

Zylos Research identifies that **"every AI agent experiences performance degradation after 35 minutes of human-equivalent task time."** This is corroborated by multiple independent sources:

- **Anthropic's own data** (2026): The 99.9th percentile Claude Code turn duration nearly doubled from under 25 minutes to over 45 minutes between Oct 2025 and Jan 2026, but these represent the extreme tail. Median turns remain ~45 seconds ([source](https://www.anthropic.com/research/measuring-agent-autonomy)).
- **Chroma's 2025 frontier model study**: Tested 18 models (GPT-4.1, Claude Opus 4, Gemini 2.5 Pro, Qwen3-235B). **All 18 exhibit degradation at every input length increment tested.** Context rot is an architectural property of transformer attention, not a capability gap training solves ([source](https://www.morphllm.com/context-rot)).
- **"Lost in the Middle"** (Liu et al., 2023, Stanford/Meta): Models attend well to the start and end of context but poorly to the middle, causing 30%+ accuracy drops. This creates a U-shaped performance curve for information retrieval within context.

However, the degradation is **continuous, not cliff-edge**. A 1M-token context window shows reliable performance in the 0–20% range (~200K tokens), with progressive degradation after that. At full capacity, 1 in 4 retrievals fail.

> **Design implication**: The ≤50% context utilization rule from the original PRD should be replaced with **degradation-driven checkpointing and restart signals** (repeated failures, circular work, repeated rereads), supplemented by in-session checkpointing. Quality degradation is observable in runtime behavior; raw context percentage is not.

### 0.3 SWE-bench failure patterns — verified

**SWE-bench Pro** (arXiv:2509.16941, 2025) is a real benchmark for long-horizon software engineering tasks. The failure analysis reveals:

| Model | Primary Failure Mode | Rate |
|-------|---------------------|------|
| Claude Sonnet 4 | Context overflow | 35.6% |
| Claude Sonnet 4 | Endless file reading | 17.0% |
| Gemini 2.5 | Tool errors | 38.8% |
| Gemini 2.5 | Syntax errors | 30.5% |
| Qwen3 32B | Tool errors | 42.0% |

The **"Endless File Reading"** pattern — agents entering loops of scanning the same directories without making progress — is Claude's second most common failure mode. This directly validates the need for stagnation detection (Section 5.8).

Top resolve rates: Claude Sonnet 4.5 at 43.6%, Claude Sonnet 4 at 42.7% ([source](https://arxiv.org/html/2509.16941v1)).

### 0.4 Context engineering — Manus and Google ADK verified

**Manus** (Yichao "Peak" Ji, 2025, [source](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)):
- Rebuilt their agent framework **four times** ("Stochastic Graduate Descent")
- Key insight: **"Leave the wrong turns in the context."** Erasing failure removes evidence; failed actions with stack traces implicitly update the model's internal beliefs.
- **Todo.md recitation pattern**: Constantly rewriting a todo list pushes the global plan into the model's recent attention span, avoiding lost-in-the-middle issues
- **KV-cache optimization is critical**: Agents average a 100:1 input-to-output token ratio. Cached-token reuse yields roughly an order-of-magnitude efficiency gain versus uncached input. Stable prompt prefixes, append-only contexts, and explicit cache breakpoints are essential.
- Average task: ~50 tool calls, tested across millions of users

**Google ADK** ([source](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/)):
- Separates **storage** (Sessions — full history) from **view** (Working Context — what the LLM sees per invocation)
- Context is **recomputed for each invocation** from underlying state — a "compiled view"
- Tiered compaction: older events get summarized via LLM calls at configurable thresholds; sessions remain manageable even for extremely long-running conversations
- Context builds through **named, ordered processors**, not ad-hoc string concatenation — making compilation observable and testable

### 0.5 The self-validation trap — verified

The claim that agents generating their own tests produce tests that pass wrong code is well-documented:

- **SWE-bench** (Jimenez et al., 2023, arXiv:2310.06770) uses human-written tests as ground truth precisely because of circular validation
- Multiple practitioners confirm: "the same person writing the exam and grading it" ([source](https://ducky.ai/blog/why-ai-coding-agents-can-t-trust-themselves-(and-neither-should-you)))
- Agents are **better at verification than implementation, and better at implementation than self-assessment**. An agent asked whether the thing it just built is correct will say yes regardless.

### 0.6 Previously unverifiable citations — corrected

| Original claim | Status | Correction |
|---------------|--------|------------|
| "Zylos Research report" | **Verified** — real research organization | Findings confirmed via web search |
| "Prassanna Ravishankar drift taxonomy (Feb 2026)" | **Unverifiable** — no independent confirmation found | Drift concepts are real; the specific taxonomy and author cannot be confirmed. We present the three drift types as an analytical framework without attribution |
| "Instruction centrifugation" | **Not an established term** | Replaced with documented phenomena: "lost-in-the-middle" effect, system prompt dilution, attention decay |

-----

## 1. Design philosophy

The system exists to make one thing safe and effective: **12-hour autonomous development runs**. Every component is infrastructure to keep the agent on track during extended autonomous operation.

### Core principles

1. **Markdown files are the management layer.** No databases, no proprietary state formats. Everything is human-readable, git-trackable, and portable.
2. **Fresh sessions per job.** Each unit of work runs in a clean context window. This is the primary defense against error compounding and context rot. Sessions should checkpoint/restart when quality degrades (repeated failures, circular work, repeated file rereads).
3. **Context is a compiled view, not a file dump.** Inspired by Google ADK: raw state goes through transformation passes to produce the minimal, relevant view for each job. The agent never loads raw files — it loads a compiled bootstrap context.
4. **Documents stay synchronized with reality.** Knowledge docs are the live source of truth that agents read from and write back to during implementation. Every write is confidence-tagged.
5. **Purpose alignment over spec compliance.** The agent checks "does this serve the original purpose?" not just "does this pass the tests?" Specs have holes; the agent fills them by reasoning about intent.
6. **Async human steering.** The user can inject messages at any time. The agent picks them up at natural checkpoints. Messages are classified as context (default), directives, or emergencies.
7. **Leave the wrong turns in context.** Within a session, failed actions and stack traces stay visible. They implicitly update the model's beliefs and prevent repeated mistakes (validated by Manus's production experience).
8. **Separate generation from validation.** The same agent must never be the sole judge of its own work. Author and critic sessions use different context to prevent circular validation.

### 1.1 Scale-adaptive execution modes

The system scales planning overhead to task size while keeping engineering quality gates constant. This follows scale-adaptive intelligence principles: **what scales down is planning/documentation overhead, not quality enforcement**.

#### Full mode (default for significant work)

**Trigger when**:
- New feature with unclear edges
- Major refactor
- Greenfield project
- Complex change spanning multiple files/modules

**Flow**:
Interview → Spec + Harness → Visualizations → Decomposition → Execution loop

**Behavior**:
- All eval stages active
- Full documentation generated across `.tenet/` layers

#### Standard mode (medium-complexity tasks)

**Trigger when**:
- Adding a well-understood feature to existing code
- Implementing from an already clear spec
- Moderate complexity with limited unknowns

**Flow**:
Brief clarification (not full interview) → Quick spec → Execution

**Behavior**:
- May run as a single job when decomposition is unnecessary
- Harness is inherited from existing project harness when present, otherwise default harness
- Eval still runs; critic session may be skipped for trivial risk profiles
- Documentation is light-touch: update existing knowledge/status docs, create new docs only when needed

#### Quick mode (small isolated tasks)

**Trigger when**:
- Bug fix
- Typo/content correction
- Config tweak
- Small isolated, clear single-file modification

**Flow**:
Direct execution with harness enforcement

**Behavior**:
- Skip interview, skip spec drafting, skip decomposition
- Still run formatting, linting, and tests per harness
- Minimal documentation updates (typically status + brief lesson if relevant)

#### Mode detection and override

The system auto-selects mode using:
- **Scope signals**: likely file count, cross-module/interface impact
- **Complexity signals**: ambiguity level, number of unknowns, requirement volatility
- **Existing context signals**: whether `.tenet/` already contains usable harness/spec state

User override is always allowed:
- "Use full mode"
- "Quick fix, just do it"

Mode choice changes process overhead only. **Harness quality enforcement applies in all modes.**

-----

## 2. System lifecycle

### 2.1 Overview

```
Ideation → Interview + Visual Artifacts → Spec + Harness (+ reference visuals)
          → Dependency Graph → [Dev Loop + Execution Visualizations] → Done
                                     ↑
                                User Steer (async)
```

Two distinct phases:

- **Crystallization phase** (human-heavy): Ideation → Interview (+ visual artifacts) → Spec + Harness (+ reference visuals) → Dependency Graph. Goal: reduce ambiguity until autonomous execution is safe.
- **Execution phase** (agent-heavy): The 12-hour dev loop. Goal: execute the dependency graph autonomously, with human steering as optional async input, while generating visual artifacts when they improve understanding or alignment.

### 2.2 Ideation

The entry point. A vague idea arrives. The system detects whether this is:

- **Greenfield**: New project — proceed directly to interview
- **Brownfield**: Existing codebase — run staged onboarding (Section 10) before interview

### 2.3 Interview

**Purpose**: Extract hidden assumptions, expose contradictions, crystallize the idea into something executable.

**Method**: Socratic questioning combined with ontological analysis.

- Socratic: "Why do you want this? What if you don't get it? What are you assuming?"
- Ontological: "What IS this, really? Is that the root cause or a symptom?"

#### Artifact-anchored ambiguity gate

The interview does not end when the user feels ready. It ends when the ambiguity score drops below threshold. **Critically, this score is anchored to concrete artifacts, not LLM self-assessment** (the adversarial review correctly identified LLM self-scoring as circular and unreliable).

```
Ambiguity = 1 - Clarity
Clarity = Σ(score_i × weight_i)

Goal clarity (weight 0.4):
  1.0 = Written acceptance test exists for primary goal
  0.7 = Scenario-based acceptance criteria exist (Section 2.3.2)
  0.5 = Qualitative description exists ("it should feel fast")
  0.2 = Only vague direction ("something for podcasts")
  0.0 = No goal stated

Constraints (weight 0.3):
  1.0 = Harness constraints defined + danger zones listed
  0.7 = Major constraints enumerated but not formalized
  0.3 = Implicit constraints only ("use our existing stack")
  0.0 = No constraints discussed

Success criteria (weight 0.3):
  1.0 = Measurable criteria with numbers ("< 1s load time")
  0.7 = Scenario-based criteria (user does X → Y happens)
  0.4 = Qualitative criteria ("easy to use")
  0.0 = "I'll know it when I see it"

Gate: Ambiguity ≤ 0.2 (Clarity ≥ 0.8)
```

This scoring is **deterministic** — either the artifact exists or it doesn't. The interviewer's job is to keep asking questions until enough artifacts exist.

#### 2.3.1 Visualization & mockup generation

Visual artifacts are **not limited to UI**. They are any diagram/mockup/visualization that helps the user understand what is being planned or built.

**Format rule**: visual artifacts are stored as **self-contained HTML files** in `.tenet/visuals/` (embedded CSS/SVG/JS, no external dependencies). AI agents should treat HTML as the native medium for generated visuals — not PNG/JPEG generation.

Use visual artifacts whenever a picture would reduce ambiguity or improve alignment. Common artifact types inside these HTML files:

- **UI mockups** (frontend/user-facing features)
- **SVG-based architecture diagrams** (component boundaries, service relationships, data flow)
- **Interactive flowcharts** (processes, state machines, user journeys)
- **Data model visualizations with styled tables** (entity relationships, schema structure)
- **System state diagrams** (runtime modes, transitions, failure states)
- **CSS-styled component relationship maps**, problem visuals, and deployment/infrastructure diagrams

A single HTML artifact may contain multiple diagrams on one page (e.g., architecture + data flow + component relationships), or the orchestrator can emit multiple HTML files when topics warrant separate pages.

For UI-facing work, generate **3-5 divergent mockups** representing meaningfully different approaches (not cosmetic variations):

```
Interview → Identify communication-critical surfaces
  → Generate visual artifact set (UI mockups / architecture / flows / data model as needed)
  → For UI: generate mockup A/B/C (and optionally D/E) with distinct interaction models
  → User selects direction (or hybrid)
  → Selected artifacts become REFERENCE ARTIFACTS in spec
```

Reference HTML artifacts enable concrete comparison during purpose alignment eval — "does implementation match approved visuals?" is more checkable than pure narrative interpretation.

Tools: React/HTML for UI and inline SVG/CSS/JS for diagrams. Output must be self-contained `.html` artifacts.

#### 2.3.2 Scenario-based acceptance criteria

Replace vague purpose statements with concrete user scenarios:

```markdown
## Scenario: First-time podcast listener
Alice opens the dashboard for the first time. She sees:
- A curated list of 5 recommended episodes based on her interests
- Each episode shows title, duration, and a 2-sentence summary
- She taps an episode → playback starts within 1 second
- She can adjust playback speed without leaving the current screen
```

#### 2.3.3 Anti-scenarios (what "bad" looks like)

```markdown
## Anti-scenario: Information overload
Alice opens the dashboard and sees 50 episodes in a flat list with no
organization. She doesn't know where to start. She closes the app.
```

Anti-scenarios are often easier for users to articulate and give the eval a negative check: "Does the implementation match any anti-scenario?"

Scenarios and anti-scenarios serve triple duty:
1. During interview: forces concrete thinking about "good" and "bad"
2. During spec: becomes testable acceptance criteria
3. During purpose alignment eval: agent walks through each scenario step-by-step

#### Interview output artifacts

- Interview transcript with decisions and rationale
- Rejected alternatives (why NOT certain approaches)
- Ambiguity score history (with artifact evidence)
- Scenario and anti-scenario acceptance criteria
- Reference visual artifacts (self-contained HTML mockups/diagrams/flows/data models/infrastructure visuals)

**Interview is iterative**: Users return when they change their mind or discover new requirements. Each re-interview updates artifacts and triggers cascade checks downstream.

### 2.4 Spec + Harness

**Spec**: The crystallized output of the interview. Defines WHAT to build, with acceptance criteria per component. Includes scenario-based ACs, measurable targets, and reference artifacts.

**Harness**: A strict engineering quality contract that defines HOW implementation quality is enforced:

- **Formatting contract**: project formatter and required flags
- **Linting contract**: zero-tolerance lint policy
- **Testing contract**: unit + integration/e2e requirements, including coverage thresholds for new code
- **Architecture contract**: structural rules (e.g., validation middleware, dependency boundaries)
- **Code principles**: style and design principles to guide implementation
- **Testing strategy**: what must be tested, when, and at what depth
- **Danger zones**: files/directories the agent must never modify
- **Iron laws**: invariants that must hold (e.g., "all monetary values use Decimal, never float")
- **Property specifications**: invariant properties for property-based testing (defined BEFORE implementation)

Harness enforcement is **strict**: any harness violation is an automatic eval failure.

**Spec ↔ Harness relationship**: Bidirectional. The harness constrains the spec; the spec informs the harness. After both are set, a "harness lock" moment — subsequent spec changes that break harness constraints are flagged, not silently accepted.

The system ships with a **default harness** suitable for most projects. Custom harnesses are reusable across projects.

```markdown
## Harness: Quality Contract

### Formatting & Linting
formatter: prettier (--single-quote --trailing-comma all)
linter: eslint (strict mode, zero warnings)
enforcement: pre-commit + eval gate — violations fail the build

### Testing Requirements
unit_test_coverage: >= 80% for new code
e2e_required_for: user-facing features, API endpoints
test_framework: vitest (unit), playwright (e2e)
rule: no code merges without passing tests

### Architecture Rules
- No circular dependencies between modules
- All API endpoints must have input validation middleware
- Database access only through the model layer, never direct SQL in routes
- Error responses follow a consistent JSON schema

### Code Principles
- Prefer composition over inheritance
- Explicit over implicit (no magic strings, no hidden side effects)
- Functions do one thing
- All public APIs must have TypeScript types (no `any`)

### Testing Strategy
- New behavior requires tests in the same change
- Bug fixes require a regression test that fails before the fix
- Property-based tests cover declared invariants
- E2E tests verify user-critical flows and integration boundaries

### Danger Zones (do not modify)
- infrastructure/prod/
- migrations/legacy/

### Iron Laws (invariants that must always hold)
- All monetary values use Decimal, never float
- Auth tokens are never logged or exposed in error messages
```

### 2.5 Dependency graph (recursive decomposition)

**Purpose**: Split the spec into jobs small enough for a single agent session.

**Method**: Recursive divide-and-conquer in fresh sessions.

#### Step 1: Coarse split

Decompose the spec into 5-8 coarse chunks. For each chunk, declare:
- What it does
- Which other chunks it depends on (dependency edges)
- Expected interfaces between chunks

#### Step 2: Context-window-aware size check

For each chunk, spawn a **fresh session** that receives only the chunk definition, relevant project context, and knowledge docs.

The session evaluates whether the chunk can be completed without long-context quality degradation. Decomposition is judgment-driven and based on:

- **Logical cohesion**: one coherent concern per job
- **Context requirements**: only the minimum surrounding code needed to execute safely
- **Interface boundaries**: split at natural boundaries with explicit contracts

If a chunk needs broad context, spans multiple concerns, or crosses too many interfaces, split further.

#### Step 3: Build the execution graph

Output is a **directed acyclic graph (DAG)** of leaf-node jobs with dependency edges:
- What can run in parallel (independent branches)
- What must be sequential (dependent chains)
- Where integration eval checkpoints go (after dependency groups complete)

#### Recording decomposition decisions

Every split decision is recorded in `knowledge/decomposition.md`:
- Why the chunk was split
- What interfaces are expected between sub-chunks
- The dependency edges
- Context-loading assumptions and why the chosen split minimizes degradation risk

-----

## 3. Bootstrap compiler

**This is a new component not in the original PRD.** Inspired by Google ADK's "compiled context" architecture.

### 3.1 Problem

The original design described loading 5 separate files at session bootstrap (status.md, knowledge docs, decomposition.md, lessons.md, harness constraints). This is a flat file list, not a compiled view. It risks loading irrelevant information, stale entries, and low-confidence knowledge.

### 3.2 Solution: compilation pipeline

Before each dev session starts, a cheap, fast bootstrap compilation step produces a minimal Working Context:

```
Raw state (all .agent/ files)
  → Relevance filter: which files matter for THIS job?
  → Recency filter: within each file, what's current vs. historical?
  → Interface extraction: from decomposition.md, extract only interfaces this job touches
  → Confidence filter: prioritize [implemented-and-tested] over [decision-only] entries
  → Steer integration: fold in any pending context-type steer messages tagged for this job
  → Todo recitation: append the current job's objectives and remaining tasks at the END
      of the compiled context (leveraging recency bias in attention)
  → Working Context: single compiled document the dev session loads
```

### 3.3 Why todo recitation matters

Manus discovered that **constantly rewriting a todo list pushes the global plan into the model's recent attention span**, avoiding lost-in-the-middle issues and reducing goal misalignment. This uses natural language to bias the model's focus toward the task objective without architectural changes.

By placing the todo/objectives at the **end** of the compiled context, we exploit the U-shaped attention curve (models attend well to beginning and end, poorly to middle) to keep the current job's goals in high-attention positions.

### 3.4 KV-cache optimization

Following Manus's production findings (100:1 input-to-output token ratio, ~10x efficiency difference between cached and uncached tokens):

- **Stable prompt prefixes**: The harness and system instructions occupy the same prefix across sessions for the same project, maximizing cache hits
- **Append-only contexts within a session**: Never rewrite earlier context; only append new observations
- **Explicit cache breakpoints**: Structure the compiled context so the stable portion (harness, spec summary) comes first, followed by the job-specific portion

-----

## 4. Execution loop (the 12-hour run)

### 4.1 Loop structure

```
[Pick next job from graph] → Dev → Eval → Learn → [Check steer inbox] → Loop
                                     ↓ (fail)
                                  Reflect → Learn → Dev (retry)
```

### 4.2 Session bootstrap

Each job runs in a fresh session. The session loads the **compiled Working Context** (Section 3) — not raw files. This keeps bootstrap context minimal and relevant.

### 4.3 Dev phase

The agent implements the current job. During implementation, it:

- Writes code
- **Updates the relevant knowledge doc** with confidence tags as it makes implementation decisions

#### Confidence-tagged knowledge writes

Every knowledge doc write is tagged with a confidence indicator to combat **memory drift** — the phenomenon where agent-authored "truths" in external memory become unquestioned ground truth for downstream jobs:

```markdown
## Token refresh strategy [confidence: implemented-and-tested]
Refresh tokens are rotated on each use. The old token is invalidated
immediately after the new one is issued.

## Rate limiting approach [confidence: implemented-not-tested]
Using token bucket algorithm with 100 req/min per user.

## WebSocket reconnection [confidence: decision-only]
Will use exponential backoff with jitter. Not yet implemented.
```

Downstream jobs reading knowledge docs weight information by confidence level. A `[decision-only]` entry is treated as a plan, not a fact.

**Three types of drift this addresses** (analytical framework based on observed agent failure patterns):

| Drift type | Definition | Mitigation |
|-----------|-----------|------------|
| Reasoning drift | Small logical errors compound across turns | Fresh sessions per job |
| Context drift | Failed calls, verbose tracebacks crowd out signal | Bootstrap compiler filters for recency and relevance |
| Memory drift | Incomplete info written at turn 20 becomes ground truth at turn 80 | Confidence tags on all knowledge writes |

### 4.4 In-session checkpointing

Within a single job, trigger an in-session checkpoint when the agent detects quality degradation signals, such as:

- Repeated failures without net progress
- Edit-revert cycles on the same area
- Re-reading the same files without extracting new actionable information
- Reflection outputs repeating prior analysis

Checkpoint protocol:

1. Agent writes a "progress snapshot": what's done, what's remaining, key decisions made
2. Session terminates cleanly
3. New session starts with ONLY the progress snapshot + the original job spec
4. Continues from where it left off with a clean context

This is the Manus "todo.md recitation" pattern made more aggressive — instead of reciting within a dirty context, restart with a clean one to recover reasoning quality.

### 4.5 Error preservation within sessions

Within a single job's session, **keep failed actions and stack traces in the working context** rather than immediately logging to lessons.md. This follows Manus's validated finding that "erasing failure removes evidence" — the model needs to see its own failures in the same context where it's working to avoid repeating them.

Move to lessons.md only at **job completion** (pass or fail).

-----

## 5. Evaluation pipeline

### 5.1 The problem with self-validation

The research is clear: **never trust AI to both generate and validate**. When the same agent writes code and its own tests, the tests reflect the agent's understanding — which is exactly the understanding that produced any bugs.

The eval pipeline addresses this through staged evaluation with increasing rigor and decreasing circularity.

### 5.2 Stage 1: Mechanical (deterministic gate)

- Lint, build, type-check, test suite
- Catches ~60-80% of issues
- If this fails, go directly to Reflect

### 5.3 Stage 1.5: Property-based testing

**New stage**, validated by recent research. An agent at NeurIPS 2025 Deep Learning for Code Workshop demonstrated automated property-based testing across 100 Python packages:
- 984 bug reports generated, 56% confirmed valid on manual review
- Demonstrated practical throughput at package ecosystem scale
- Successfully found and patched bugs in NumPy, AWS Lambda Powertools, and Tokenizers
- Source: arXiv:2510.09907

**How it works in this system**:

Properties are specified during the **SPEC phase** (before implementation, not during dev):

```markdown
## Properties (harness/current.md)
- parse(serialize(x)) == x for all valid inputs
- monetary calculations: result is always Decimal, never float
- API responses: status codes are always in {200, 201, 400, 401, 403, 404, 500}
- Auth tokens: expired tokens always return 401, never proceed to handler
```

The agent writes Hypothesis (Python) or fast-check (JS/TS) tests that verify these properties with random inputs. Properties explore the input space the agent didn't think about.

**Key rule**: Properties are specified before implementation. The agent cannot tailor properties to pass its own code.

### 5.4 Stage 2: Spec compliance (author session)

- Check implementation against acceptance criteria
- Check for scope creep (built something not in spec?)
- Check for scope reduction (skipped something in spec?)
- **Doc-code sync check**: does the knowledge doc match what was actually implemented?

### 5.5 Stage 3: Purpose alignment (critic session)

**This stage runs in a SEPARATE session with adversarial framing** to break circular validation.

**Critic session** receives ONLY:
- The spec / acceptance criteria / scenario ACs / reference visuals (HTML artifacts)
- The harness constraints
- The code diff
- The anti-scenarios

**Critic does NOT receive**:
- The author's reasoning or reflection notes
- The author's tests
- The knowledge docs

**Critic's task**: "Find ways this implementation fails to meet the spec. Write tests that would expose these failures. Check if the implementation matches any anti-scenario."

The critic has an **information disadvantage by design** — it doesn't know the author's reasoning, so it can't be biased by the same assumptions.

**Zero-findings rule (adversarial gate)**: a critic report with zero findings is treated as suspicious, not automatically clean. The critic must either:
- produce at least one concrete finding, **or**
- explicitly justify why zero findings is legitimate (e.g., a tiny isolated config flip with no integration surface).

If the first pass returns zero findings, the critic must re-run from a different angle (security, edge cases, integration impact, anti-scenario matching) before Stage 3 can pass.

This approach is supported by research on multi-agent debate (Du et al., 2023, arXiv:2305.14325): having LLM instances evaluate from different perspectives significantly enhances reasoning accuracy. Even when all instances initially give wrong answers, debate can converge on the correct one. Later research (arXiv:2410.12853) confirmed that diversity of thought elicits stronger reasoning in multi-agent frameworks.

Run the critic session on Stage 3+ where adversarial evaluation is needed. Stages 1-2 remain deterministic and spec-focused.

### 5.6 Stage 4: Self-questioning (structured categories)

Against structured categories, not freeform:

| Category | Example questions |
|---------|------------------|
| Edge cases | "What happens with empty input? Maximum size? Special characters?" |
| Error paths | "What if the network call fails? File doesn't exist? Permissions denied?" |
| Integration points | "Does this interface match what the dependent chunk expects?" |
| User-facing behavior | "What would a user see if they did X? Is the error message helpful?" |
| Security | "Can this input be exploited? Am I validating before using?" |
| Performance | "Does this scale? N+1 queries? Obvious optimization ignored?" |
| Purpose alignment | "Does this serve the original goal, or just pass tests?" |

Generate 3-5 questions per relevant category. Attempt to answer each. Unanswerable questions become items for next iteration or user steer.

### 5.7 Eval failure → Reflect

When eval fails, the agent does NOT immediately retry. Reflect step produces:

- **Root cause analysis**: not "the test failed" but "why did I write code that fails this test?"
- **Alternative approaches**: at least 2 different strategies
- **Recommendation**: which approach to try next
- **Pattern match**: has this failure pattern appeared before? (check lessons.md)

The reflection output **stays in the active session** (not just in a file) — following Manus's error preservation principle.

### 5.8 Stagnation detection

If the agent is going in circles, detect and respond.

**Detection patterns** (validated by SWE-bench Pro analysis showing 17% "Endless File Reading" failure rate):

| Pattern | Signal | Detection method |
|---------|--------|-----------------|
| Same test failing N times | Strong | Compare test output hashes across iterations |
| Eval scores plateau | Medium | No improvement in quantified eval for 3+ iterations |
| Edit-revert cycles | Strong | Compare git diffs — if similarity > threshold, agent is cycling |
| Repeated file rereads without new findings | Medium | Track repeated reads of identical files with no new decisions or diffs |
| Repeated identical tool calls | Strong | Exact match on recent tool call history |

**Response — Persona rotation**:

Instead of retrying harder, switch thinking mode. This is supported by multi-agent debate research (Du et al., 2023) showing that diverse perspectives improve reasoning, and by Ouroboros's production implementation of lateral thinking personas:

| Persona | Directive |
|---------|----------|
| Hacker | "Make it work, elegance be damned" |
| Researcher | "Stop coding, read the docs and source code" |
| Simplifier | "Cut scope, return to MVP" |
| Architect | "Question the foundation — is the approach wrong?" |
| Contrarian | "Are we solving the wrong problem entirely?" |

After a persona switch, if still stuck after 2 more attempts: **halt the job and wait for user steer**. Don't burn 8 more hours on a dead end.

### 5.9 Integration eval

After a **group of related jobs** completes (a dependency group in the DAG):

- Load all completed pieces for this group
- Check: "Do the pieces work together?"
- Verify the expected interfaces declared during decomposition
- Run integration tests

If integration eval fails:
- Identify which interface broke
- Check decomposition.md for original assumptions
- Re-decompose affected edges if needed
- Create new jobs to fix integration

-----

## 6. Three types of cascade checks

The original PRD bundled all cascade operations into one "cascade check." The adversarial review correctly identified that these are fundamentally different operations.

### Type 1: Document-to-document alignment

- **Input**: Two markdown documents (e.g., interview current.md and spec current.md)
- **Question**: "Do these documents contradict each other?"
- **Method**: Load both docs, diff key claims, flag contradictions
- **Operational overhead**: Low (two docs, one LLM call)
- **Trigger**: Any upstream document update

### Type 2: Code-to-document alignment

- **Input**: A knowledge doc + the actual code it describes
- **Question**: "Does this document accurately describe what the code does?"
- **Method**: Load the doc and relevant code files, check for mismatches
- **Operational overhead**: Medium (doc + code, may need multiple files)
- **Trigger**: After every completed job — knowledge docs must reflect implementation reality

### Type 3: Trajectory-to-purpose alignment (drift detection)

- **Input**: Original interview artifacts + current status.md + recent knowledge doc changes
- **Question**: "Is the project still heading toward the original goal?"
- **Method**: Summarize recent changes, compare direction against purpose statement and scenarios
- **Operational overhead**: Low-medium (summary + comparison)
- **Trigger**: Every N iterations (configurable, default 3)

Each type has different triggers, different inputs, and different response strategies. Running them separately prevents vague prompts that miss subtle issues.

-----

## 7. Async user steering

### 7.1 Mechanism

The user writes to `steer/inbox.md` at any time. The agent checks at natural checkpoints:
- After each eval step
- Before picking the next job
- Check is cheap: compare file mtime, zero LLM invocation if nothing's there

### 7.2 Message classification

**Context messages** (default — no prefix):
- Information the agent should factor into decisions
- "OAuth should use PKCE flow" → folded into next job's bootstrap
- "Users complain about slow loading" → priority signal

**Directive messages** (`DIRECTIVE:` prefix):
- Changes job priority, adds to backlog/spec
- "DIRECTIVE: Stop working on admin panel" → reorders job queue
- "DIRECTIVE: Add webhook support" → adds to spec, triggers cascade

**Emergency messages** (`EMERGENCY:` prefix):
- "EMERGENCY: Database migration corrupting data" → halt immediately

### 7.3 Multi-job relevance

Steer messages are tagged by the orchestrator with affected job IDs before delivery:

```markdown
## 2026-04-02 14:30 [affects: auth-oauth, auth-basic, api-endpoints]
OAuth should use PKCE flow, not implicit grant
```

The orchestrator does the tagging (cheap — check job descriptions against steer message keywords). Each job only sees steer messages tagged for it. Messages that can't be auto-tagged go to all pending jobs.

### 7.4 After handling

- Move from `steer/inbox.md` to `steer/processed.md`
- If steer changes interview-level or spec-level decisions, trigger cascade checks
- Processed steer becomes part of project history

### 7.5 Inline message acknowledgment and status tracking

Each steer message gets inline status tracking in `steer/inbox.md` so users can see, at a glance, what has been seen and acted on.

**Status lifecycle**: `received` → `acknowledged` → `acted_on` → `resolved`

Rules:
- User writes message content.
- Agent appends/updates the status tag and agent response.
- `received`: agent has seen message but not processed it yet.
- `acknowledged`: agent understands it and has a plan.
- `acted_on`: agent has applied changes from the message.
- `resolved`: concern fully addressed.
- Agent MUST update status at each checkpoint; no silent messages.

Example:

```markdown
## MSG-001 [2026-04-06 14:30] [STATUS: resolved]
Make player controls touch-friendly with 44px tap targets.
> Agent: Acknowledged. Folded into JOB-007 compiled context. Applied in JOB-007 attempt 2. Touch targets set to 48px (exceeds 44px minimum).

## MSG-002 [2026-04-06 15:00] [STATUS: acknowledged]
DIRECTIVE: Skip admin dashboard for now.
> Agent: Queue reordered. JOB-007 moved to backlog. Cascade check passed.

## MSG-003 [2026-04-06 16:45] [STATUS: received]
EMERGENCY: Memory leak in Safari audio player.
```

-----

## 8. Document architecture

### 8.1 Directory structure

```
.tenet/
├── index.md                 # Auto-generated file inventory + status + health summary
├── interview/
│   ├── current.md          # Latest interview state (why)
│   ├── scenarios.md        # User scenarios + anti-scenarios
│   ├── changelog.md        # What changed per iteration
│   └── archive/            # Compacted older changelogs
├── visuals/
│   ├── architecture-overview.html   # System architecture diagram
│   ├── data-model.html              # Entity relationships
│   ├── user-flows.html              # User journey flowcharts
│   └── ...
├── spec/
│   ├── current.md          # Live spec (what)
│   ├── properties.md       # Property-based test specifications
│   ├── changelog.md
│   └── archive/
├── harness/
│   ├── current.md          # Active quality contract (how quality is enforced)
│   ├── changelog.md
│   └── archive/
├── status/
│   ├── status.md           # Current project state (where)
│   ├── job-queue.md        # Remaining jobs in dependency order
│   └── backlog.md          # Future work, low priority
├── knowledge/
│   ├── decomposition.md    # Why jobs were split, expected interfaces
│   ├── auth.md             # Per-concern knowledge (how) — confidence-tagged
│   ├── data-model.md
│   ├── api.md
│   └── ...
├── lessons/
│   ├── current.md          # Active lessons (what we tried)
│   ├── changelog.md
│   └── archive/
├── steer/
│   ├── inbox.md            # User message content + agent inline status/ack updates
│   └── processed.md        # Agent moves handled messages here
└── bootstrap/
    └── compiler.md         # Bootstrap compiler configuration
```

**Note**: The directory is named `.tenet/` (the project name), not `.agent/` (generic). This avoids conflicts with other tools and makes the system identifiable.

### 8.2 Layer definitions

| Layer | Purpose | Updated by | Read by |
|-------|---------|-----------|--------|
| Interview | The "why" — decisions, rationale, scenarios | User + interview agent | Drift correction, purpose alignment eval |
| Spec | The "what" — acceptance criteria, properties, scope | User + spec agent | Job generation, eval criteria, critic session |
| Harness | The "quality contract" — formatting/lint/testing/architecture/style + danger zones + iron laws | User (usually once) | Every session bootstrap (via compiler) |
| Status | The "where" — current state, job queue | Agent (automated) | Session bootstrap, job dispatch |
| Knowledge | The "how" — implementation details per concern | Agent during dev (confidence-tagged) | Sub-agents during dev (via compiler) |
| Lessons | The "what we tried" — patterns, failures | Agent after job completion | Reflection step, future planning |
| Steer | The "user says" — async messages | User (anytime) | Agent at checkpoints, compiler for context-type messages |

### 8.3 Concern-based knowledge docs

Knowledge docs are organized by **concern** (auth, data model, API surface), NOT by **phase** (requirements, architecture, stories).

**Why**: Phase-based docs go stale because the "architecture doc" doesn't know the developer changed the data model in sprint 3. Concern-based docs mean the agent updates the same file it reads from. This is consistent with **Domain-Driven Design** (Evans, 2003) and the **Living Documentation** approach (Martraire, 2019).

Each knowledge file contains:
- Current architecture decisions for this concern
- Key interfaces (what other concerns depend on)
- Known constraints and trade-offs
- **Confidence tags** on every section
- Last updated timestamp

### 8.4 Tiered compaction

Every layer that grows follows the same compaction pattern (aligned with Google ADK's tiered compaction approach):

```
current.md      → Always up to date. Agents read THIS.
changelog.md    → What changed and why. Append-only.
archive/        → Summarized older changelogs.
```

**Compaction trigger**: When `changelog.md` exceeds threshold (50 entries or ~10K tokens), summarize older entries into `archive/YYYY-MM.md`. Google ADK implements this via async LLM summarization at configurable thresholds.

| Layer | Growth pattern | Compaction need |
|-------|---------------|----------------|
| Interview | Bounded by project scope | Low-medium |
| Spec | Bounded by project scope | Low-medium |
| Status | Constant if completed jobs move to changelog | Low |
| Knowledge | Bounded by number of concerns | Medium |
| Lessons | Unbounded — grows with every failure | High |

### 8.5 Auto-generated `.tenet/index.md`

`index.md` is orchestrator-maintained and regenerated automatically as a table of contents + health surface for `.tenet/`.

It includes:
- Every file under `.tenet/` with last-modified timestamp
- One-line summary of each file's purpose/content
- Status indicators (`active`, `stale`, `archived`)
- Approximate token size

Example row set:

```markdown
# .tenet/ Index
Last updated: 2026-04-06 16:30

## Active Documents
| File | Modified | Summary | Status |
|------|----------|---------|--------|
| spec/current.md | 2026-04-06 | Podcast dashboard v1 spec with 5 ACs | active |
| knowledge/data-model.md | 2026-04-06 | SQLite schema: podcasts, episodes, playback_state [impl+tested] | active |
| knowledge/audio-player.md | 2026-04-05 | Howler.js wrapper, resume < 800ms [impl+tested] | active |
| steer/inbox.md | 2026-04-06 | 3 messages (1 resolved, 1 acknowledged, 1 received) | active |
| visuals/architecture-overview.html | 2026-04-04 | System architecture SVG diagram | active |
| runs/JOB-001/... | 2026-04-04 | Data models job, 1 attempt, passed | archived |
```

### 8.6 Document health audit

A periodic document health audit catches "work done but docs not updated" drift. It runs:
- after every N completed jobs (default: 3)
- whenever `index.md` is regenerated
- on explicit user request

Checks:
1. **Orphaned files**: `.tenet/` files not referenced by active job/spec/knowledge docs
2. **Stale documents**: confidence tags inconsistent with current code state
3. **Missing updates**: completed jobs that did not update expected knowledge docs
4. **Broken references**: docs pointing to missing files/jobs
5. **Inconsistencies**: contradictions across docs (document-to-document cascade)
6. **Unacknowledged steer messages**: inbox entries stuck at `received` too long

Output is written into an `index.md` health section or a dedicated `health-report.md` with severity levels.

-----

## 9. Safety and resilience gates

### 9.1 Preventing runaway execution

| Gate | Mechanism |
|------|----------|
| Staleness detector | If 3+ iterations produce similar eval results, halt after persona rotation |
| Repetition detector | If edit-revert cycles or repeated file rereads are detected, force checkpoint-and-restart |
| Max consecutive failures | After N failures on same job, mark blocked, move to next |
| Degradation-driven checkpointing | When quality signals degrade, write snapshot and restart in fresh session |
| Checkpoint/resume integrity | Every successful iteration persists status + commit metadata for crash recovery |

### 9.2 Checkpoint and resume

After each successful iteration:
1. Update `status.md` with current state
2. Commit to git with structured metadata
3. State is sufficient to resume if process crashes

Resume protocol:
1. Read `status.md` — which job was in progress?
2. Check git log — last successful commit?
3. If in-progress job has partial work: decide continue from partial or restart fresh
4. Continue dependency graph from where it left off

### 9.3 Progress reporting

`status.md` is human-readable at all times:

```markdown
# Project status

## Current run
- Started: 2026-04-02 09:00
- Elapsed: 6h 23m
- Jobs completed: 12/18
- Jobs remaining: 5
- Jobs blocked: 1 (auth-oauth — stagnation after 3 attempts)
- Current job: api-webhooks (iteration 2, integration schema validation)

## Last 5 iterations
- api-webhooks iter 1: eval pass (mechanical), fail (integration — missing event schema)
- api-endpoints iter 3: pass all stages
- ...

## Steer inbox
- 1 unprocessed message (received 14:30, classified: context)
```

-----

## 10. Brownfield project onboarding

### The problem

Full-project documentation is prohibitively slow and noisy for large codebases. The system needs to understand only the parts the user's idea touches.

### Staged approach

**Stage 0a: Skeleton scan** (minutes)
- Directory structure, file count, language breakdown
- Package dependencies (package.json, requirements.txt, etc.)
- CI/CD configuration
- Output: `knowledge/project-overview.md` (structural, not semantic)

**Stage 0b: Targeted deep scan** (scoped to user's idea)
- User says "add OAuth support" → scan only auth-related files, API routes, middleware
- Use file names, imports, and grep to identify relevant code
- Output: `knowledge/auth.md` (generated from existing code, confidence-tagged as `[scanned-not-verified]`)

**Stage 0c: Interface extraction**
- For files identified in 0b, extract public interfaces (function signatures, API routes, data models)
- Output: Interface stubs the dependency graph can reference

As work proceeds and the agent encounters dependencies on other parts of the codebase, it does **targeted scans on demand** and adds new knowledge docs. This is consistent with how Cursor's Background Agent handles brownfield: "new agents can still understand [codebases with 1M+ lines of code] and make meaningful progress" through effective context summarization and task scoping ([source](https://cursor.com/blog/scaling-agents)).

-----

## 11. Cross-platform compatibility

### 11.1 Platform differences

| Platform | Instruction file | Skill location | Session model |
|---------|----------------|---------------|--------------|
| Claude Code | CLAUDE.md | .claude/skills/*/SKILL.md | Local CLI, persistent |
| Codex | AGENTS.md | .agents/skills/*/SKILL.md | Cloud sandbox, ephemeral |
| OpenCode | AGENTS.md | .opencode/skills/ (also reads .claude/ and .agents/) | Local, configurable |

### 11.2 Compatibility strategy

Write once, generate wrappers:

1. Author all skills as `SKILL.md` files with standard YAML frontmatter
2. Generate thin platform-specific wrappers (CLAUDE.md for Claude Code, AGENTS.md for Codex/OpenCode)
3. Place skills in `.tenet/skills/` (canonical) and symlink/copy to platform directories during install

Core logic (decomposition, eval, learn, steer) is platform-agnostic — it's all markdown file operations. Only session management needs a thin adapter per platform.

### 11.3 Installation

```bash
npx tenet install --detect     # all detected platforms
npx tenet install --claude     # Claude Code only
npx tenet install --codex      # Codex only
npx tenet install --opencode   # OpenCode only
```

-----

## 12. Failure handling

### 12.1 Failure taxonomy

| Failure type | Response |
|-------------|---------|
| Mechanical (lint/build/test) | Fix directly, no reflection needed |
| Property violation (Stage 1.5) | Examine which property failed, fix the violating code path |
| Spec compliance (missed AC) | Reflect on why it was missed, then fix |
| Purpose misalignment (critic found issue) | Reflect deeply, possibly re-examine spec |
| Integration failure | Check decomposition.md interfaces, re-decompose if needed |
| Stagnation (N consecutive failures) | Switch thinking mode (persona rotation) |
| Persistent stagnation (N+2 more) | Halt job, move to next, request user steer |

### 12.2 Rollback strategy

After N consecutive failures on the same job:
1. Git stash/revert to last known good state
2. Log failure pattern in lessons.md
3. Mark job as "blocked" in status.md
4. Move to next independent job in dependency graph
5. Add steer prompt: "Job X is blocked after N attempts. Here's what I tried and why it failed."

### 12.3 Catastrophic recovery

#### `.tenet/` directory corruption or loss

- Git is the primary backup mechanism; `.tenet/` files should be committed as part of the project.
- If `.tenet/` is deleted/corrupted: restore from git.
- If git history is also unavailable: bootstrap from source code only via brownfield scan mode. Planning history is lost, but operation can continue.
- Recommendation: treat `.tenet/` as first-class project state, not disposable scratch output.

#### Danger zone violations

If an agent modifies a danger-zone path despite harness rules:
1. Immediately halt execution.
2. Git-revert the specific modified danger-zone file(s) to pre-modification state.
3. Log as a critical incident in `lessons.md`.
4. Mark the active job as failed.
5. Alert user via `steer/inbox.md` with `EMERGENCY` status.
6. Do not continue until explicit user acknowledgment.

#### Agent-created broken repository state

If execution leaves the repo in a broad broken state (e.g., build/tests catastrophically failing):
1. Git-stash all changes since the last successful checkpoint.
2. Restore repository to the last known-good checkpoint.
3. Log the failure context and suspected cause in `lessons.md`.
4. Retry from checkpoint if confidence is sufficient, otherwise escalate to user.

#### Steer inbox corruption

- `steer/inbox.md` is append-only by design, so corruption risk is low.
- If corruption occurs, execution can continue without active steer intake (pending messages may be lost).
- Historical handled messages remain recoverable in `steer/processed.md`.

#### System-level recovery principle

The system must always recover to a known-good state. Git checkpoints are the primary recovery substrate. If higher-level recovery metadata fails, `git checkout .tenet/` restores the last committed Tenet state.

-----

## 13. Implementation roadmap

### Phase 1: Core skeleton (foundation)
- `.tenet/` directory structure and document templates
- Interview agent with **artifact-anchored** ambiguity scoring
- Scenario + anti-scenario acceptance criteria
- Spec generation from interview output
- Basic harness (default quality contract)
- SKILL.md packaging for Claude Code
- **Context-window-aware job decomposition** (foundation fix #2 from adversarial review)

### Phase 2: Execution loop
- Job dispatcher with dependency graph awareness
- Dev → Eval → Learn loop (single iteration)
- Mechanical eval (lint/build/test)
- **Confidence-tagged knowledge writes**
- Status tracking and checkpoint/resume

### Phase 3: Bootstrap compiler + autonomous operation
- **Bootstrap compilation pipeline** (compiled context view)
- **Degradation-driven in-session checkpointing**
- Multi-iteration looping with stagnation detection
- Async steer inbox with context/directive/emergency classification
- Persona rotation on stagnation
- Safety and resilience gates
- **Todo recitation** at end of compiled context

### Phase 4: Advanced eval
- **Property-based testing** as Stage 1.5 (Hypothesis/fast-check integration)
- **Author/critic session split** for purpose alignment eval (Stage 3)
- Self-questioning protocol (Stage 4)
- Integration eval after dependency groups
- **Three typed cascade checks**
- Drift detection with trajectory-to-purpose alignment

### Phase 5: Cross-platform + brownfield
- Codex adapter (AGENTS.md generation, cloud sandbox support)
- OpenCode adapter
- Unified installer with platform detection
- **Staged brownfield onboarding** (skeleton → targeted → interface extraction)
- Visual communication artifacts (self-contained HTML visuals: mockups + architecture/flow/data/infrastructure diagrams)

### Phase 6: Compaction and long-term
- Tiered document compaction (aligned with Google ADK approach)
- Long-running project support (months of iterations)
- Doc audit phase (orphan detection, contradiction check)
- Backlog management and re-prioritization
- KV-cache optimization (stable prefixes, cache breakpoints)

-----

## 14. Comparison with existing frameworks

| Feature | Tenet (this system) | Cursor Background Agent | Devin | Ouroboros |
|---------|-------------------|----------------------|-------|----------|
| Session management | Fresh per job, degradation-driven checkpoints | Planner/Worker hierarchy | Persistent, Slack-based | Configurable |
| Interview | Artifact-anchored ambiguity gate | None (task-based) | None (task-based) | Socratic + ontological |
| Decomposition | Recursive, context-window-aware cohesive splits | Recursive planner/sub-planner | Internal planning | Double Diamond |
| Harness | Strict engineering quality contract (format/lint/tests/architecture/style + danger zones + iron laws) | Not documented as first-class contract | Not documented | Constraints + personas |
| Eval | 5-stage with author/critic split | Judge agent at cycle end | Internal review | 3-stage (mechanical → consensus) |
| Stagnation handling | Persona rotation + halt | Risk-averse detection | Unknown | Lateral thinking personas |
| User steering | Async classified inbox | Not documented | Slack messages | Synchronous |
| Documentation | 6-layer concern-based, confidence-tagged | Minimal (git-based) | Not documented | Database (SQLite) |
| Brownfield support | Staged scan (skeleton → targeted → interface) | Full codebase understanding | Full codebase | Brownfield scanning |
| Drift detection | 3-type cascade checks | Not documented | Not documented | Drift measurement |
| Long autonomous runs | Primary design goal (12h) | Demonstrated (weeks) | Demonstrated (hours) | Supported (evolution loop) |
| Context engineering | Compiled bootstrap, KV-cache aware | Agent-scoped context | Not documented | Not documented |

**Production scale reference points:**
- **Cursor**: Built a browser from scratch in ~1 week (1M+ LoC, 1000+ files), ran Java LSP (7.4K commits, 550K LoC), Windows 7 emulator (14.6K commits, 1.2M LoC) ([source](https://cursor.com/blog/scaling-agents))
- **Devin**: 67% PR merge rate (up from 34%), 4x faster problem-solving YoY, security fixes in 1.5 minutes (vs. 30 min human) ([source](https://cognition.ai/blog/devin-annual-performance-review-2025))
- **Anthropic multi-agent**: 90.2% improvement over single-agent Opus 4 using context isolation ([source](https://www.morphllm.com/context-rot))

-----

## 15. Open questions

1. **Ambiguity gate calibration**: The 0.2 threshold may need tuning per project type (greenfield vs brownfield, frontend vs backend). The artifact-anchored approach reduces but doesn't eliminate subjectivity in the level descriptors.

2. **Knowledge doc granularity**: How fine-grained should concerns be? Rule of thumb: one file per bounded context (DDD sense). If a knowledge file exceeds 5K tokens, consider splitting by sub-concern.

3. **Parallel job execution**: The current design assumes sequential job execution within a single agent process. True parallelism (multiple agents on different jobs) requires a coordination layer. Cursor's experience shows that self-coordinating agents with shared files and locking mechanisms fail — they need a Planner/Worker hierarchy. This is Phase 6+ complexity.

4. **Model capability selection per phase**: Not all phases need the same strengths. Interview and purpose alignment eval may require stronger reasoning and adversarial critique, while mechanical implementation may prioritize tool reliability and deterministic code editing behavior.

5. **Critic model selection**: The author/critic split works best when the critic uses a different model or at minimum different temperature/sampling. Using the exact same model with different context is better than nothing but may share blind spots.

6. **Property specification completeness**: Properties must be specified before implementation, but users may not know all relevant properties upfront. Allow the interview to surface properties iteratively, and let the harness accumulate them.

7. **Team collaboration**: Multiple users steering simultaneously, or multiple agents on the same project, introduces coordination challenges beyond the current single-user design.

-----

## Appendix A: Key references

| Source | What it provides | URL |
|--------|-----------------|-----|
| Zylos Research (2026) | 35-min degradation wall, quadratic failure scaling, Moore's Law for agents | [zylos.ai](https://zylos.ai/research/2026-01-16-long-running-ai-agents) |
| Manus context engineering (Ji, 2025) | Todo recitation, error preservation, KV-cache optimization, compiled context | [manus.im](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) |
| Google ADK | Compiled context architecture, tiered compaction, storage/view separation | [developers.googleblog.com](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/) |
| SWE-bench Pro (arXiv:2509.16941) | Agent failure taxonomy, Endless File Reading pattern, context overflow rates | [arxiv.org](https://arxiv.org/html/2509.16941v1) |
| Lost in the Middle (Liu et al., 2023) | U-shaped attention curve, 30%+ accuracy drops for middle-context info | Stanford/Meta |
| Chroma frontier model study (2025) | All 18 tested models degrade at every context length increment | [morphllm.com](https://www.morphllm.com/context-rot) |
| Multi-agent debate (Du et al., 2023) | Diverse perspectives improve reasoning; debate corrects initially-wrong answers | [arXiv:2305.14325](https://arxiv.org/abs/2305.14325) |
| Agentic PBT (arXiv:2510.09907) | Automated property-based testing finds real bugs at ecosystem scale | [arxiv.org](https://arxiv.org/html/2510.09907v1) |
| Anthropic agent autonomy (2026) | Turn duration growth, human intervention rates, auto-approve patterns | [anthropic.com](https://www.anthropic.com/research/measuring-agent-autonomy) |
| Anthropic effective harnesses (2025) | Initializer/coding agent pattern, one-feature-per-session, progress docs | [anthropic.com](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) |
| Cursor Background Agent (2026) | Planner/Worker hierarchy, recursive decomposition, million-LoC projects | [cursor.com](https://cursor.com/blog/scaling-agents) |
| Devin performance review (2025) | 67% merge rate, 4x speed improvement, enterprise adoption data | [cognition.ai](https://cognition.ai/blog/devin-annual-performance-review-2025) |
| Reflexion (Shinn et al., 2023) | Verbal reinforcement learning, reflection as error compounding mitigation | arXiv:2303.11366 |
| Towards AI Agent Reliability (2026) | Benchmark accuracy ≠ operational reliability | [arXiv:2602.16666](https://arxiv.org/html/2602.16666v1) |
| Diversity of Thought in Debate (2024) | Diversity elicits stronger reasoning in multi-agent frameworks | [arXiv:2410.12853](https://arxiv.org/abs/2410.12853) |

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| Bootstrap compiler | The pipeline that transforms raw .tenet/ state into a minimal compiled context for a job session |
| Confidence tag | A label on knowledge doc entries: `[implemented-and-tested]`, `[implemented-not-tested]`, `[decision-only]`, `[scanned-not-verified]` |
| Context rot | Progressive degradation of LLM performance as context window fills — universal across all transformer models |
| Critic session | A separate eval session that receives only spec + code diff, deliberately excluded from the author's reasoning |
| Drift (reasoning) | Small logical errors compounding across turns within a session |
| Drift (context) | Failed calls and verbose tracebacks crowding out signal in context |
| Drift (memory) | Incomplete/incorrect info in external memory becoming ground truth for downstream jobs |
| Lost-in-the-middle | The phenomenon where LLMs attend well to context beginning/end but poorly to the middle |
| Harness | A strict engineering quality contract that enforces formatting, linting, testing, architecture rules, code principles, danger zones, and iron laws |
| Persona rotation | Switching between problem-solving modes (Hacker/Researcher/Simplifier/Architect/Contrarian) to break stagnation |
| Property-based test | A test that verifies an invariant property holds for all inputs, not just specific examples |
| Scale-adaptive mode | The system's ability to adjust planning/documentation overhead by task complexity (full/standard/quick) while maintaining consistent harness quality enforcement |
| Todo recitation | Rewriting objectives at the end of context to exploit recency bias in attention |
| Visual artifact | A self-contained `.html` output (embedded SVG/CSS/JS) containing UI mockups and/or diagrams used to improve alignment and understanding |
