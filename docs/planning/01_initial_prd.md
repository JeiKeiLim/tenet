# Long-Running AI Agent Plugin System

## Comprehensive Design Guideline

**Version**: 0.1 (Draft)
**Date**: 2026-04-02
**Purpose**: Design specification for a cross-platform AI agent plugin that enables 12-hour autonomous development cycles with human steering, structured documentation, and recursive task decomposition.

**Target platforms**: Claude Code, OpenAI Codex, OpenCode (and any agent supporting SKILL.md / AGENTS.md conventions)

-----

## 1. Design philosophy

The entire system exists to make one thing safe and effective: **12-hour autonomous development runs without human intervention**. Every component — the interview, the spec, the harness, the documentation layers, the eval loop, the steer mechanism — is infrastructure to keep the agent on track during extended autonomous operation.

### Core principles

1. **Markdown files are the management layer.** No databases, no proprietary state formats. Everything is human-readable, git-trackable, and portable across agent platforms.
1. **Fresh sessions per job.** Each unit of work runs in a clean context window. No context rot. Session boundary target: ≤50% context utilization per job.
1. **Documents stay synchronized with reality.** Docs are not generated-then-forgotten artifacts. They are the live source of truth that agents read from and write back to during implementation.
1. **Purpose alignment over spec compliance.** The agent doesn’t just check “does this pass the tests?” — it checks “does this serve the original purpose?” Specs have holes. The agent fills them by reasoning about intent.
1. **Async human steering.** The user can toss messages at any time without stopping the agent. The agent picks them up at natural checkpoints.

-----

## 2. System lifecycle

### 2.1 Overview

```
Ideation → Interview → Spec + Harness → Dependency Graph → [Dev Loop] → Done
                                                              ↑
                                                         User Steer (async)
```

The system has two distinct phases:

- **Crystallization phase** (human-heavy): Ideation → Interview → Spec + Harness → Dependency Graph. Goal: reduce ambiguity to a level where autonomous execution is safe.
- **Execution phase** (agent-heavy): The 12-hour dev loop. Goal: execute the dependency graph autonomously, with human steering as an optional async input.

### 2.2 Ideation

The entry point. A vague idea arrives from the user. This can be:

- A greenfield project (“build me a podcast dashboard”)
- A new feature for an existing project (“add OAuth support”)
- A bug fix or refactor (“the auth flow is broken when tokens expire”)

The system should detect whether this is greenfield or brownfield and adjust subsequent phases accordingly. Brownfield projects need a codebase scan before interview.

### 2.3 Interview

**Purpose**: Extract hidden assumptions, expose contradictions, crystallize the idea into something executable.

**Method**: Socratic questioning combined with ontological analysis.

- Socratic: “Why do you want this? What if you don’t get it? What are you assuming?”
- Ontological: “What IS this, really? Is that the root cause or a symptom?”

**Ambiguity gate**: The interview does not end when the user feels ready. It ends when a quantified ambiguity score drops below threshold.

```
Ambiguity = 1 - Clarity
Clarity = Σ(score_i × weight_i) for each dimension

Dimensions and weights:
  - Goal clarity:       weight 0.4
  - Constraints:        weight 0.3
  - Success criteria:   weight 0.3

Gate: Ambiguity ≤ 0.2 (i.e., Clarity ≥ 0.8)
```

Each dimension is scored 0.0-1.0 based on how specifically the user has defined it. The interviewer agent should surface the current ambiguity score and tell the user which dimensions need more clarity.

**Mockup generation**: During interview, the agent can generate UI mockups or architecture sketches to validate understanding. These feed back into the interview as visual confirmation — “is this what you mean?”

**Interview is iterative**: This is NOT a one-time phase. Users return to the interview when they change their mind, add features, or discover new requirements. Each re-interview updates the interview artifacts and triggers a cascade check downstream.

**Output artifacts**:

- Interview transcript with decisions and rationale
- Rejected alternatives (why NOT certain approaches)
- Ambiguity score history

### 2.4 Spec + Harness

**Spec**: The crystallized output of the interview. Defines WHAT to build, with acceptance criteria for each component.

**Harness**: Defines constraints on HOW the agent operates. This includes:

- Danger zones: files/directories the agent must never modify
- Iron laws: invariants that must hold (e.g., “all monetary values use Decimal, never float”)
- Eval checklist templates: categories the agent must check during self-evaluation
- Tool restrictions: which tools are allowed per phase
- Cost ceilings: budget gates per iteration

**Relationship**: Spec ↔ Harness is bidirectional. The harness constrains the spec (you can’t specify something the harness forbids), and the spec informs the harness (new features may require new danger zones). Once both are set, there’s a “harness lock” moment — subsequent spec changes that break harness constraints are flagged, not silently accepted.

**Harness can be default or custom**: The system ships with a default harness suitable for most projects. Users can customize it for domain-specific constraints. Custom harnesses are reusable across projects.

**Spec is iterative**: Like the interview, the spec evolves. Feature additions, scope changes, and bug discoveries all update the spec. Each update triggers a cascade check.

### 2.5 Dependency graph (recursive decomposition)

**Purpose**: Split the spec into jobs small enough for a single agent session (≤50% context window).

**Method**: Recursive divide-and-conquer in fresh sessions.

#### Step 1: Coarse split

In the initial session, decompose the spec into 5-8 coarse chunks. For each chunk, declare:

- What it does
- Which other chunks it depends on (dependency edges)
- Expected interfaces between chunks (how they connect)

#### Step 2: Recursive size check

For each chunk, spawn a **fresh session** that receives only:

- The chunk definition
- Relevant project context (not the full spec)
- The knowledge docs for related concerns

The session asks: “Can you complete this in ≤50% context? If not, how would you split it further?”

If the chunk needs splitting:

- Generate sub-chunks with their own dependency edges
- Declare expected interfaces between sub-chunks
- Recurse until all leaf nodes pass the size check

#### Step 3: Build the execution graph

The output is a directed acyclic graph (DAG) of leaf-node jobs with dependency edges. This determines:

- What can run in parallel (independent branches)
- What must be sequential (dependent chains)
- Where integration eval checkpoints go (after dependency groups complete)

#### Recording decomposition decisions

Every split decision is recorded in `knowledge/decomposition.md`:

- Why the chunk was split
- What interfaces are expected between sub-chunks
- The dependency edges

This record serves two purposes:

1. If integration eval fails, the re-decomposition has history to learn from
1. Sub-agents can read the decomposition rationale to understand architectural decisions

-----

## 3. Execution loop (the 12-hour run)

### 3.1 Loop structure

```
[Pick next job from graph] → Dev → Eval → Learn → [Check steer inbox] → Loop
                                     ↓ (fail)
                                  Reflect → Learn → Dev (retry)
```

### 3.2 Session bootstrap

Each job runs in a fresh session. The session loads **only**:

1. `status.md` — where are we in the overall project?
1. `knowledge/{relevant-concern}.md` — what does this job need to know?
1. `knowledge/decomposition.md` — what are the interfaces and dependencies?
1. `lessons.md` (current) — what should I avoid?
1. The harness constraints relevant to this job

This is the minimal token cost to start working. No full repo scan. No full spec reload.

### 3.3 Dev phase

The agent implements the current job. During implementation, it:

- Writes code
- **Updates the relevant knowledge doc** as it makes implementation decisions. This is not a separate phase — it’s part of dev. The knowledge doc for the concern being worked on should reflect the implementation reality after dev completes.

### 3.4 Eval phase

Eval is staged to control cost:

#### Stage 1: Mechanical (zero LLM cost)

- Lint, build, type-check, test suite
- Catches ~80% of issues
- If this fails, go directly to Reflect without spending tokens on deeper eval

#### Stage 2: Spec compliance

- Check implementation against acceptance criteria
- Check for scope creep (did the agent build something not in the spec?)
- Check for scope reduction (did the agent skip something in the spec?)
- **Doc-code sync check**: does the knowledge doc match what was actually implemented?

#### Stage 3: Purpose alignment

- Re-read the project purpose statement (from interview artifacts)
- Ask: “Does what I just built actually serve this purpose, or does it just pass the tests?”
- This catches the case where acceptance criteria had gaps — the code passes all ACs but doesn’t serve the user’s actual intent
- This is the “senior developer code review” that agents typically skip

#### Stage 4: Self-questioning

- Against structured categories: edge cases, error paths, integration points, user-facing behavior
- “What would a real user try that I haven’t tested?”
- “What assumptions am I making that aren’t in the spec?”
- Generate questions, then attempt to answer them. Unanswerable questions become items for the next iteration or for user steer.

### 3.5 Eval failure → Reflect

When eval fails, the agent does NOT immediately retry. It enters a **reflect** step:

- What specifically failed?
- Why did it fail? (Root cause, not symptom)
- What could be done differently?
- Has this failure pattern appeared before? (Check lessons.md)

The reflection output feeds into Learn before retrying. This prevents the agent from retrying the same approach repeatedly.

### 3.6 Learn phase

After each iteration (pass or fail), the agent appends to lessons:

- What worked / what didn’t
- Patterns discovered
- Decisions made and their rationale

Learn is append-only within an iteration. Compaction happens separately (see Document Architecture).

### 3.7 Integration eval

After a **group of related jobs** completes (i.e., a dependency group in the DAG), an integration eval runs:

- Load all completed pieces for this group
- “Do the pieces work together?”
- Check the expected interfaces declared during decomposition
- Run integration tests if they exist

If integration eval fails:

- Identify which interface broke
- Check decomposition.md for the original assumptions
- Re-decompose the affected edges if needed
- Create new jobs to fix the integration

### 3.8 Stagnation detection

If the agent is going in circles (consecutive iterations produce similar eval results), it should detect this and respond:

**Detection patterns**:

1. Same test failing for N consecutive iterations
1. Eval scores plateauing (no improvement)
1. Agent making and reverting similar changes
1. Token spend increasing without progress

**Response**: Instead of retrying harder, switch thinking mode:

- Hacker: “Make it work, elegance be damned”
- Researcher: “Stop coding, read the docs”
- Simplifier: “Cut scope, return to MVP”
- Architect: “Question the foundation”
- Contrarian: “Are we solving the wrong problem?”

After a mode switch, if still stuck after 2 more attempts, **halt and wait for user steer**. Don’t burn 8 more hours on a dead end.

### 3.9 Drift detection

Every N iterations (configurable, default 3), run a drift check:

- Re-read the project purpose (interview artifacts)
- Compare current implementation trajectory against original intent
- Measure drift as a delta between intended direction and actual direction

If drift exceeds threshold:

- Trigger a cascade check (see Document Architecture)
- Potentially re-examine the spec
- If drift is severe, halt and request user steer

### 3.10 Cost and safety gates

- **Per-iteration token budget**: if a single iteration exceeds the budget, pause and log why
- **Cumulative cost tracking**: running total of spend, visible in status.md
- **Max consecutive failures**: after N failures on the same job, halt that job and move to the next (don’t block the entire pipeline)
- **Checkpoint/resume**: after each successful iteration, update status.md with enough state to resume from if the process crashes

-----

## 4. Async user steering

### 4.1 Mechanism

The user can write to `steer/inbox.md` at any time — while the agent is on hour 6 of a 12-hour run. The agent doesn’t watch this file continuously. It checks at natural checkpoints:

- After each eval step (natural pause point)
- Before picking the next job from the queue
- The check is cheap: compare file mtime, zero token cost if nothing’s there

### 4.2 Steer inbox format

```markdown
## 2026-04-02 14:30
OAuth should use PKCE flow, not implicit grant

## 2026-04-02 15:45
URGENT: Stop working on the admin panel, focus on user-facing features first

## 2026-04-02 16:00
New feature: add webhook support for external integrations
```

### 4.3 Message classification

When the agent reads a steer message, it classifies it:

|Type               |Action                                                       |Timing                     |
|-------------------|-------------------------------------------------------------|---------------------------|
|Course correction  |Adjust current plan, note in processed.md                    |After current job completes|
|Spec change        |Update spec current.md, run cascade check, re-prioritize jobs|After current job completes|
|Pause/redirect     |Mark current job as paused, skip to next                     |After current job completes|
|New feature request|Append to backlog.md, don’t disrupt current work             |No disruption              |

### 4.4 Priority convention

- **Default**: Finish current job, then apply the steer before picking the next job
- **URGENT: prefix**: Abandon current job immediately, apply the steer now

### 4.5 After handling

- Move the message from `steer/inbox.md` to `steer/processed.md`
- If the steer changes interview-level or spec-level decisions, it triggers the same cascade check as any document update
- The processed steer becomes part of the project history

-----

## 5. Document architecture

### 5.1 Directory structure

```
.agent/
├── interview/
│   ├── current.md          # Latest interview state (why)
│   ├── changelog.md        # What changed per iteration
│   └── archive/            # Compacted older changelogs
├── spec/
│   ├── current.md          # Live spec (what)
│   ├── changelog.md        # Spec evolution history
│   └── archive/
├── harness/
│   ├── current.md          # Active constraints (how to operate)
│   ├── changelog.md
│   └── archive/
├── status/
│   ├── status.md           # Current project state (where)
│   ├── job-queue.md        # Remaining jobs in dependency order
│   └── backlog.md          # Future work, low priority
├── knowledge/
│   ├── decomposition.md    # Why jobs were split, expected interfaces
│   ├── auth.md             # Per-concern knowledge (how)
│   ├── data-model.md
│   ├── api.md
│   └── ...                 # One file per concern
├── lessons/
│   ├── current.md          # Active lessons (what we tried)
│   ├── changelog.md
│   └── archive/
└── steer/
    ├── inbox.md            # User writes here (async)
    └── processed.md        # Agent moves handled messages here
```

### 5.2 Layer definitions

|Layer    |Purpose                                                         |Updated by                      |Update frequency   |Read by                                 |
|---------|----------------------------------------------------------------|--------------------------------|-------------------|----------------------------------------|
|Interview|The “why” — decisions, rationale, rejected alternatives         |User + interview agent          |Per user iteration |Drift correction, purpose alignment eval|
|Spec     |The “what” — acceptance criteria, scope                         |User + spec agent               |Per feature cycle  |Job generation, eval criteria           |
|Harness  |The “how to operate” — constraints, danger zones, eval templates|User (usually once, then rarely)|Rare, deliberate   |Every session bootstrap                 |
|Status   |The “where” — current state, job queue                          |Agent (automated)               |Every iteration    |Session bootstrap, job dispatch         |
|Knowledge|The “how” — implementation details per concern                  |Agent during dev                |During dev phase   |Sub-agents during dev                   |
|Lessons  |The “what we tried” — patterns, failures, discoveries           |Agent after eval                |After eval failures|Reflection step, future planning        |
|Steer    |The “user says” — async messages                                |User (anytime)                  |Anytime            |Agent at checkpoints                    |

### 5.3 Tiered compaction

Every layer that grows over time follows the same compaction pattern (inspired by Obsidian daily → monthly → compact summary):

```
current.md      → Always up to date. Agents read THIS.
changelog.md    → What changed and why. Append-only. Agents read only for debugging/drift.
archive/        → Summarized older changelogs. Read only for deep history.
```

**Compaction trigger**: When `changelog.md` exceeds a configurable threshold (e.g., 50 entries or ~10K tokens), summarize older entries into `archive/YYYY-MM.md` and ensure `current.md` still reflects the latest truth.

**Growth characteristics by layer**:

|Layer    |Growth pattern                                         |Compaction need              |
|---------|-------------------------------------------------------|-----------------------------|
|Interview|Bounded by project scope, grows with feature iterations|Low-medium                   |
|Spec     |Bounded by project scope, grows with feature iterations|Low-medium                   |
|Status   |Constant size if completed jobs move to changelog      |Low                          |
|Knowledge|Bounded by number of concerns, grows with codebase     |Medium                       |
|Lessons  |Unbounded — grows with every failure                   |High (periodic summarization)|

### 5.4 Cascade on update

When an upstream document changes, downstream documents may be invalidated. The cascade check propagates:

```
Interview changes → Check spec alignment
  → Check knowledge alignment
    → Check status (are completed jobs still valid?)
```

This is not a full re-run. It’s a targeted check: “does downstream still hold given this upstream change?” The cascade agent loads only the changed upstream doc and the downstream `current.md` files, checks for contradictions, and either:

- Auto-fixes minor inconsistencies (e.g., renaming a concept)
- Flags major contradictions for user review
- Regenerates affected parts of the dependency graph

### 5.5 Concern-based knowledge docs

Knowledge docs are organized by **concern** (auth, data model, API surface), NOT by **phase** (requirements, architecture, stories).

Why: Phase-based docs go stale because the “architecture doc” doesn’t know that the developer changed the data model in sprint 3. Concern-based docs mean the agent updates the same file it reads from. When the agent implements auth, it reads `knowledge/auth.md`, and writes back to `knowledge/auth.md` with what it actually built.

Each knowledge file should contain:

- Current architecture decisions for this concern
- Key interfaces (what other concerns depend on)
- Known constraints and trade-offs
- Last updated timestamp

-----

## 6. Cross-platform compatibility

### 6.1 Platform differences

|Platform   |Instruction file|Skill location                                                |Session model           |
|-----------|----------------|--------------------------------------------------------------|------------------------|
|Claude Code|CLAUDE.md       |.claude/skills/*/SKILL.md                                     |Local CLI, persistent   |
|Codex      |AGENTS.md       |.agents/skills/*/SKILL.md                                     |Cloud sandbox, ephemeral|
|OpenCode   |AGENTS.md       |.opencode/skills/*/SKILL.md (also reads .claude/ and .agents/)|Local, configurable     |

### 6.2 Compatibility strategy

The SKILL.md format (YAML frontmatter + markdown body) is nearly identical across all three platforms. This is the canonical authoring format.

**Write once, generate wrappers**:

1. Author all skills as `SKILL.md` files with standard YAML frontmatter (name, description, allowed-tools)
1. Generate thin platform-specific wrappers:
- `CLAUDE.md` for Claude Code (references the skills)
- `AGENTS.md` for Codex/OpenCode (references the skills)
1. Place skills in `.agent/skills/` (the canonical location) and symlink or copy to platform-specific directories during install

**Platform abstraction**:

- The orchestrator layer (which dispatches jobs, manages sessions, tracks state) needs a thin adapter per platform
- Core logic (decomposition, eval, learn, steer) is platform-agnostic — it’s all markdown file operations
- Session management differs most: Claude Code runs locally with persistent filesystem; Codex runs in cloud sandboxes. The adapter handles this.

### 6.3 Installation

```bash
# Install for all platforms detected
npx agent-plugin install --detect

# Install for specific platform
npx agent-plugin install --claude
npx agent-plugin install --codex
npx agent-plugin install --opencode
```

The installer:

1. Detects which platforms are available
1. Creates `.agent/` directory structure
1. Copies/symlinks skills to platform-specific locations
1. Generates platform-specific instruction files
1. Sets up the steer inbox

-----

## 7. Eval self-questioning protocol

### 7.1 Structured categories

The agent’s self-questioning is NOT freeform. It follows structured categories to prevent drift:

|Category            |Example questions                                                                                      |
|--------------------|-------------------------------------------------------------------------------------------------------|
|Edge cases          |“What happens with empty input? With maximum size? With special characters?”                           |
|Error paths         |“What if the network call fails? What if the file doesn’t exist? What if permissions are denied?”      |
|Integration points  |“Does this interface match what the dependent chunk expects? Did I break any existing contracts?”      |
|User-facing behavior|“What would a user see if they did X? Is the error message helpful? Does the loading state make sense?”|
|Security            |“Can this input be exploited? Am I validating before using? Are secrets exposed?”                      |
|Performance         |“Does this scale? Am I doing N+1 queries? Is there an obvious optimization I’m ignoring?”              |
|Purpose alignment   |“Does this serve the original goal? Or am I building something that passes tests but misses the point?”|

### 7.2 Question generation and resolution

1. Generate 3-5 questions per category (not all categories every time — focus on what’s relevant to the current job)
1. Attempt to answer each question by examining the implementation
1. Questions that can be answered: verify the answer, fix if wrong
1. Questions that CANNOT be answered: these become either:
- Items for the next iteration (if the agent can investigate further)
- Items for user steer (if only the user can decide)
- Noted risks in lessons.md (if acceptable to proceed with uncertainty)

-----

## 8. Failure handling

### 8.1 Failure taxonomy

|Failure type                             |Response                                                 |
|-----------------------------------------|---------------------------------------------------------|
|Mechanical (lint/build/test)             |Fix directly, no reflection needed                       |
|Spec compliance (missed AC)              |Reflect on why it was missed, then fix                   |
|Purpose misalignment                     |Reflect deeply, possibly re-examine spec                 |
|Integration failure                      |Check decomposition.md interfaces, re-decompose if needed|
|Stagnation (N consecutive failures)      |Switch thinking mode (persona rotation)                  |
|Persistent stagnation (N+2 more failures)|Halt job, move to next, request user steer               |

### 8.2 Reflect step

The reflect step is distinct from learn. Learn accumulates across iterations; reflect is immediate and tactical.

Reflect produces:

- Root cause analysis (not just “the test failed” but “why did I write code that fails this test?”)
- Alternative approaches (at least 2 different strategies)
- Recommendation on which approach to try next
- Whether this failure pattern has appeared before (check lessons.md)

### 8.3 Rollback strategy

After N consecutive failures on the same job:

1. Git stash/revert to last known good state
1. Log the failure pattern in lessons.md
1. Mark the job as “blocked” in status.md
1. Move to the next independent job in the dependency graph
1. Add a steer prompt for the user: “Job X is blocked after N attempts. Here’s what I tried and why it failed. How should I proceed?”

-----

## 9. 12-hour run safety

### 9.1 Preventing runaway execution

- **Iteration budget**: Each iteration has a max token budget. Exceeding it triggers a pause.
- **Cumulative cost cap**: Total spend for the run has a configurable ceiling.
- **Staleness detector**: If consecutive iterations produce similar eval results (plateau), halt and wait for steer after N iterations.
- **Max wall-clock per job**: No single job should take more than M minutes (configurable). If exceeded, force-complete with whatever state exists and move on.

### 9.2 Checkpoint and resume

After each successful iteration:

1. Update `status.md` with current state
1. Commit to git with structured metadata
1. State is sufficient to resume from if the process crashes at hour 8

Resume protocol:

1. Read `status.md` — which job was in progress?
1. Check git log — what was the last successful commit?
1. If the in-progress job has partial work, decide: continue from partial or restart the job fresh
1. Continue the dependency graph from where it left off

### 9.3 Progress reporting

`status.md` should be human-readable at all times:

```markdown
# Project status

## Current run
- Started: 2026-04-02 09:00
- Elapsed: 6h 23m
- Jobs completed: 12/18
- Jobs remaining: 5
- Jobs blocked: 1 (auth-oauth — stagnation after 3 attempts)
- Current job: api-webhooks (iteration 2)
- Total cost: $X.XX

## Last 5 iterations
- api-webhooks iter 1: eval pass (mechanical), fail (integration — missing event schema)
- api-endpoints iter 3: pass all stages
- ...

## Steer inbox
- 1 unprocessed message (received 14:30)
```

-----

## 10. Implementation roadmap

### Phase 1: Core skeleton

- `.agent/` directory structure and document templates
- Interview agent with ambiguity scoring
- Spec generation from interview output
- Basic harness (default constraints)
- SKILL.md packaging for Claude Code

### Phase 2: Execution loop

- Job dispatcher with dependency graph awareness
- Dev → Eval → Learn loop (single iteration)
- Mechanical eval (lint/build/test)
- Status tracking and checkpoint/resume

### Phase 3: Autonomous operation

- Multi-iteration looping with stagnation detection
- Async steer inbox mechanism
- Drift detection and cascade checks
- Persona rotation on stagnation
- Cost tracking and safety gates

### Phase 4: Advanced eval

- Purpose alignment eval (stage 3)
- Self-questioning protocol (stage 4)
- Integration eval after dependency groups
- Reflect step with root cause analysis

### Phase 5: Cross-platform

- Codex adapter (AGENTS.md generation, cloud sandbox support)
- OpenCode adapter
- Unified installer with platform detection
- Recursive decomposition in fresh sessions

### Phase 6: Compaction and long-term

- Tiered document compaction
- Long-running project support (months of iterations)
- Doc audit phase (orphan detection, contradiction check)
- Backlog management and re-prioritization

-----

## 11. Open questions

These items need further design work:

1. **Ambiguity scoring calibration**: The 0.2 threshold and dimension weights are borrowed from Ouroboros. They may need tuning for different project types (greenfield vs brownfield, frontend vs backend vs infrastructure).
1. **Knowledge doc granularity**: How fine-grained should concerns be? Too coarse (one file for “backend”) and it grows too large. Too fine (one file per function) and there are too many files to manage.
1. **Parallel job execution**: The current design assumes sequential job execution within a single agent process. True parallelism (multiple agent sessions running simultaneously) requires a coordination layer that prevents conflicts. This is a significant complexity increase.
1. **Model selection per phase**: Not all phases need the same model. Interview and purpose alignment eval may need frontier models. Mechanical dev tasks may work fine with cheaper models. The PAL router concept from Ouroboros (1x/10x/30x tiers) is worth exploring.
1. **Brownfield project onboarding**: How does the system bootstrap when there’s an existing codebase? The interview needs to understand what exists. The knowledge docs need to be generated from existing code. The harness needs to be inferred from existing conventions.
1. **Team collaboration**: The current design assumes a single user + agent. Multiple users steering simultaneously, or multiple agents working on the same project, introduces coordination challenges.
1. **Metrics and observability**: Beyond cost tracking, what metrics should the system expose? Iterations per job, eval pass rate, drift measurements, steer response time?

-----

## Appendix A: Comparison with existing frameworks

|Feature            |This system                   |GSD-2                       |Ouroboros                        |BMAD                    |
|-------------------|------------------------------|----------------------------|---------------------------------|------------------------|
|Session management |Fresh per job, ≤50% context   |Fresh per plan, ~50% context|Configurable                     |Single session per story|
|Interview          |Quantified ambiguity gate     |Discussion phase            |Socratic + ontological           |Analyst + PM agents     |
|Decomposition      |Recursive in fresh sessions   |Aggressive atomicity        |Double Diamond                   |Epic → Story → Task     |
|Eval               |4-stage (mechanical → purpose)|Goal-backward verification  |3-stage (mechanical → consensus) |Code review agent       |
|Stagnation handling|Persona rotation + halt       |Stuck loop detection        |Lateral thinking personas        |Manual                  |
|User steering      |Async inbox, anytime          |Synchronous commands        |Synchronous                      |Synchronous             |
|Documentation      |5-layer concern-based         |Externalized state files    |Database (SQLite)                |Phase-based docs        |
|Cross-platform     |Claude/Codex/OpenCode         |Claude/Codex/OpenCode/Gemini|Claude/Codex (via orchestrator)  |Claude/Cursor/VS Code   |
|Drift detection    |Purpose alignment + cascade   |Context monitoring          |Drift measurement + retrospective|Manual                  |
|12h autonomous     |Primary design goal           |Supported (auto mode)       |Supported (evolution loop)       |Not designed for this   |

## Appendix B: File format conventions

### SKILL.md frontmatter

```yaml
---
name: agent-plugin-interview
description: |
  Conducts Socratic interview with ambiguity scoring.
  Triggers on: "start new project", "interview", "new feature"
allowed-tools: Read, Write, Edit, Bash
---
```

### Status.md structure

```markdown
# Status

## Run
started: 2026-04-02T09:00:00Z
current_job: api-webhooks
iteration: 2
jobs_done: 12
jobs_total: 18
jobs_blocked: 1
cost_usd: 4.32

## Job queue
1. [done] auth-basic
2. [done] data-model
3. [in-progress] api-webhooks
4. [pending] api-endpoints (depends: api-webhooks)
5. [blocked] auth-oauth (stagnation)
...

## Blocked jobs
- auth-oauth: 3 attempts failed. Root cause: unclear token refresh strategy. Needs user steer.
```

### Steer inbox format

```markdown
## YYYY-MM-DD HH:MM
[URGENT:] message text

Free-form text. The agent classifies it.
```
