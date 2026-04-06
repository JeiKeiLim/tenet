# Long-Running AI Agent Plugin: Research-Based Improvements

**Based on**: Error compounding research, Manus context engineering lessons, Google ADK architecture, SWE-bench agent failure analysis, and adversarial testing best practices.

**Date**: 2026-04-02

-----

## 1. The Core Problem: Error Compounding

### What the research says

The math is unforgiving. A 95% per-step accuracy over 20 steps yields only 36% end-to-end success. At 100 steps, even 1% error rates become near-certain collapse. The Zylos Research report identifies a critical threshold: **agent performance degrades measurably after 35 minutes of human-equivalent task time**. After that, compounding accelerates.

The agent drift research from Prassanna Ravishankar (Feb 2026) identifies three distinct drift types that your doc conflates into one:

- **Reasoning drift**: Small logical errors compound across turns. A wrong assumption at turn 20 becomes a confident wrong plan by turn 50.
- **Context drift**: Failed API calls, verbose tracebacks, and superseded reasoning pile up, crowding out the signal. Old decisions bleed into new situations because they’re still present in context and indistinguishable from current ones.
- **Memory drift**: When an agent writes to external memory based on incomplete information at turn 20, that becomes ground truth for retrieval at turn 80.

Your system’s fresh-session-per-job design already mitigates reasoning drift and context drift within a single job. **But memory drift is your blind spot** — your knowledge docs and lessons.md ARE the external memory, and they accumulate agent-authored “truths” that downstream jobs treat as ground truth.

### Improvement: Confidence-tagged knowledge writes

Every time the agent writes to a knowledge doc, it should tag the write with a confidence indicator:

```markdown
## Token refresh strategy [confidence: implemented-and-tested]
Refresh tokens are rotated on each use. The old token is invalidated
immediately after the new one is issued.

## Rate limiting approach [confidence: implemented-not-tested]
Using token bucket algorithm with 100 req/min per user.

## WebSocket reconnection [confidence: decision-only]
Will use exponential backoff with jitter. Not yet implemented.
```

Downstream jobs reading knowledge docs can then weight information appropriately. A “decision-only” entry shouldn’t be treated with the same authority as “implemented-and-tested”. This is cheap to implement and directly addresses the memory drift problem.

-----

## 2. Context Engineering: Lessons from Manus and Google ADK

### The “clean desk” principle

Manus discovered (after four complete framework rebuilds) that the key insight isn’t about context window size — it’s about what the agent sees at every step. They formalize this as: **context is a compiled view over a richer stateful system**, not a mutable string buffer.

Google’s ADK architecture formalizes this further with three design principles:

1. **Separate storage from view**: Sessions (full history) are distinct from Working Context (what the LLM sees for this one invocation).
1. **Compiled context**: Like a compiler pipeline — raw state goes through transformation passes to produce the minimal, relevant view.
1. **Tiered compaction**: Newer tool results stay in full detail; older ones get compacted or replaced with handles.

### What this means for your design

Your session bootstrap (Section 3.2) is on the right track but needs the ADK “compiled view” concept. Currently you describe loading files — status.md, knowledge docs, decomposition.md, lessons.md. This is a flat file list, not a compiled view.

**Improvement: Bootstrap compiler**

Instead of loading raw files, add a bootstrap compilation step that produces a minimal Working Context:

```
Raw state (all .agent/ files)
  → Relevance filter (which files matter for THIS job?)
  → Recency filter (within each file, what's current vs. historical?)
  → Interface extraction (from decomposition.md, extract only the interfaces this job touches)
  → Confidence filter (from knowledge docs, prioritize implemented-and-tested over decision-only)
  → Working Context (what the agent actually sees)
```

This compilation step runs in a cheap, fast session before the dev session starts. The output is a single “compiled context” document that the dev session loads — not 5 separate files.

### Error preservation (counterintuitive but validated)

Manus found that **leaving failed actions and stack traces in context helps the agent avoid repeating mistakes**. Your current design moves error information to lessons.md, which is loaded at bootstrap. But the Manus insight is more specific: the model needs to see its own failures in the same context where it’s working, not in a separate “lessons learned” document.

**Improvement**: For retry loops within a single job, keep the failure trace in the working context rather than just logging to lessons.md. Only move to lessons.md at job completion. This matches your existing reflect step — but make it explicit that the reflection output stays in the active session, not just in a file.

-----

## 3. The Self-Validation Trap

### The fundamental problem

Your 4-stage eval assumes the agent can evaluate its own work. The research consistently warns against this. The key principle from testing AI-generated code research: **never trust AI to both generate and validate.** Generate and verify must be separate steps, ideally with different models or different context.

The SWE-bench experience is instructive. When agents write code and their own tests, they produce tests that pass the wrong code. The tests reflect the agent’s understanding of the problem, which is exactly the understanding that produced the bug.

### Improvement: Split eval into author and critic

Instead of one agent doing both dev and eval, split the eval into a separate session with adversarial framing:

**Author session** (current dev agent):

- Implements the job
- Writes implementation tests
- Updates knowledge docs

**Critic session** (separate, fresh context):

- Receives ONLY: the spec/acceptance criteria, the harness constraints, and the code diff
- Does NOT receive: the author’s reasoning, the author’s tests, or the knowledge docs
- Task: “Find ways this implementation fails to meet the spec. Write tests that would expose these failures.”

The critic has an information disadvantage by design — it doesn’t know the author’s reasoning, so it can’t be biased by the same assumptions. This is more expensive (two sessions per eval) but directly addresses the circular validation problem.

For cost control, run the critic session only on Stage 3+ evals (purpose alignment and self-questioning). Stages 1-2 (mechanical and spec compliance) can stay as-is.

### Improvement: Property-based testing as stage 1.5

Between mechanical eval (lint/build/test) and spec compliance, add property-based testing:

```
Stage 1:   Mechanical (lint, build, type-check, existing tests)
Stage 1.5: Property-based (auto-generated fuzz/property tests)
Stage 2:   Spec compliance
Stage 3:   Purpose alignment (critic session)
Stage 4:   Self-questioning
```

Property-based tests explore the input space the agent didn’t think about. Tools like Hypothesis (Python) or fast-check (JS) generate random inputs guided by type information. The agent specifies properties (“this function should never return negative values”, “parse(serialize(x)) == x”) and the framework finds counterexamples.

This is cheap, deterministic, and catches edge cases that both the author and critic might miss. The key rule: the agent specifies properties during the SPEC phase, before implementation, not during dev.

-----

## 4. Ideation & Interview: Compensating for Taste

### The taste problem, reframed

Your intuition is right: the ideation/interview/mockup phase is where taste gets encoded. Once execution starts, the agent can only be “correct” relative to what was crystallized. If the crystallization was shallow, the execution will be technically correct but unsatisfying.

The research on AI design tools (Figma, Uizard, Stitch/Galileo) reveals a pattern: **generating multiple variations quickly is what compensates for lack of taste**. A human designer doesn’t have perfect taste either — they generate options and select. The selection is where taste lives.

### Improvement: Divergent mockup generation

During interview, when UI or user-facing behavior is involved, generate **3-5 divergent mockups**, not one. Each mockup should represent a meaningfully different approach, not just cosmetic variations:

```
Interview → Identify UI-facing components
  → Generate mockup A (minimal/functional)
  → Generate mockup B (content-rich/informational)  
  → Generate mockup C (interaction-heavy/dynamic)
  → User selects direction (or hybrid)
  → Selected mockup becomes part of the spec as a REFERENCE ARTIFACT
```

The reference artifact is critical. During execution, the purpose alignment eval (Stage 3) can compare the implementation against the selected mockup — not just against textual acceptance criteria. “Does this screen look and feel like the mockup the user approved?” is a much more concrete eval than “does this serve the purpose?”

Tools like Stitch (Google), UX Pilot, and Uizard can generate these mockups from text descriptions in seconds. The agent can generate React/HTML mockups directly as artifacts during the interview phase.

### Improvement: Scenario-based acceptance criteria

Replace vague purpose statements with concrete user scenarios written during the interview:

```markdown
## Scenario: First-time podcast listener
Alice opens the dashboard for the first time. She sees:
- A curated list of 5 recommended episodes based on her interests (entered during onboarding)
- Each episode shows title, duration, and a 2-sentence summary
- She taps an episode → playback starts immediately with no loading screen > 1 second
- She can adjust playback speed from the player bar without leaving the current screen

## Scenario: Returning power user  
Bob has listened to 50+ episodes. He opens the dashboard and sees:
- His listening history organized by topic clusters
- A "continue where you left off" section at the top
- New episodes since his last visit highlighted with a badge
- He can search across all episodes by keyword in transcript
```

These scenarios serve triple duty:

1. During interview: forces the user to think concretely about what “good” means
1. During spec: becomes testable acceptance criteria
1. During purpose alignment eval: the agent walks through each scenario step-by-step against the implementation

This is the “concrete user scenario” approach mentioned in the previous review, now formalized as part of the interview output artifacts.

### Improvement: Anti-scenarios (what “bad” looks like)

Equally important — define what bad looks like:

```markdown
## Anti-scenario: Information overload
Alice opens the dashboard and sees 50 episodes in a flat list with no
organization. She doesn't know where to start. She closes the app.

## Anti-scenario: Empty state confusion  
Bob opens the app for the first time and sees a completely empty dashboard
with just a "Subscribe to podcasts" button. He doesn't know what the app does.
```

Anti-scenarios are often easier for users to articulate than positive scenarios (“I don’t want it to feel like X”). They give the purpose alignment eval a negative check: “Does the current implementation match any anti-scenario?”

-----

## 5. The 35-Minute Degradation Wall

### What happens at the boundary

Research consistently identifies a performance cliff around 35 minutes of equivalent human task time, or 20-100 agent turns. After this point:

- **Instruction centrifugation**: As execution logs accumulate, they push the original system prompt to the periphery of the model’s effective attention (this follows from how softmax attention works — recent tokens dominate).
- **Stale reasoning**: Chain-of-thought from turn 10 becomes misleading at turn 60 when the situation has changed, but there’s no mechanism to mark old reasoning as superseded.
- **Repetitive loops**: SWE-bench Pro researchers observed “Endless File Reading” in 17% of Claude Sonnet 4 failures — the agent enters a loop of scanning the same directories, believing it’s making progress.

### Why your fresh-session design helps (but isn’t sufficient)

Your ≤50% context utilization rule is the right instinct — it keeps individual sessions under the degradation threshold. But the degradation wall applies within a session, and some jobs will hit it even under 50%.

**Improvement: In-session checkpointing with context refresh**

Within a single job, if the agent has been working for more than N turns (configurable, start with 30), trigger an in-session checkpoint:

1. Agent writes a “progress snapshot” to a temp file: what’s done, what’s remaining, key decisions made
1. Session terminates cleanly
1. New session starts with ONLY the progress snapshot + the original job spec
1. Continues from where it left off, but with a clean context

This is essentially the Manus “todo.md recitation” pattern, but more aggressive — instead of reciting within a dirty context, you restart with a clean one. The cost is an extra session bootstrap. The benefit is escaping the degradation cliff.

**Improvement: Turn budget per job**

Instead of measuring context utilization (which the agent can’t do reliably), measure **turn count**. This is trivially observable:

```markdown
## Job constraints
max_turns: 40          # hard limit, checkpoint-and-restart after this
warning_turns: 30      # agent should wrap up or checkpoint
estimated_turns: 15    # decomposition estimate (informational)
```

If actual turns consistently exceed estimated turns, that’s a signal the decomposition was wrong — the job should have been split further.

-----

## 6. Cascade Check: Making It Concrete

### Three distinct check types

Your cascade check bundles fundamentally different operations. Split them:

**Type 1: Document-to-document alignment**

- Input: Two markdown documents (e.g., interview current.md and spec current.md)
- Question: “Do these documents contradict each other?”
- Method: Load both docs, diff key claims, flag contradictions
- Cost: Low (two docs, one LLM call)

**Type 2: Code-to-document alignment**

- Input: A knowledge doc + the actual code it describes
- Question: “Does this document accurately describe what the code does?”
- Method: Load the doc and the relevant code files, check for mismatches
- Cost: Medium (doc + code, may need multiple files)
- This is critical after every job — the knowledge doc must reflect implementation reality

**Type 3: Trajectory-to-purpose alignment**

- Input: Original interview artifacts + current status.md + recent knowledge doc changes
- Question: “Is the project still heading toward the original goal?”
- Method: Summarize recent changes, compare direction against purpose
- Cost: Low-medium (summary + comparison)
- This is your drift detection, formalized

Each type has different triggers, different inputs, and different response strategies. Don’t bundle them into one “cascade check” — it’ll become a vague prompt that misses subtle issues.

-----

## 7. Async Steer: Context Feed, Not Command Channel

### Reclassification

Based on your insight that steer messages should be context rather than commands, reclassify:

**Context messages** (default — no special prefix):

- “OAuth should use PKCE flow” → information the agent should factor into decisions
- “The auth library we’re using doesn’t support refresh token rotation” → constraint the agent should know about
- “Users have complained about slow loading on the current version” → priority signal

**Directive messages** (explicit `DIRECTIVE:` prefix):

- “DIRECTIVE: Stop working on admin panel, focus on user-facing features” → changes job priority
- “DIRECTIVE: Add webhook support as a new feature” → adds to backlog/spec

**Emergency messages** (explicit `EMERGENCY:` prefix):

- “EMERGENCY: The database migration script is corrupting data” → halt immediately

The distinction matters because context messages get folded into the next job’s bootstrap (compiled view includes relevant steer context), while directives require action from the orchestrator (reorder job queue, update spec), and emergencies require immediate interruption.

### Handling multi-job relevance

Your observation about “which job picks up a steer message about auth when multiple jobs touch auth” is real. The solution: steer messages are tagged by the orchestrator with affected job IDs before being delivered:

```markdown
## 2026-04-02 14:30 [affects: auth-oauth, auth-basic, api-endpoints]
OAuth should use PKCE flow, not implicit grant
```

The orchestrator does the tagging (cheap — check job descriptions against steer message keywords). Each job only sees steer messages tagged for it. Messages that can’t be auto-tagged go to all pending jobs.

-----

## 8. Brownfield Onboarding: The “Phase 0” Problem

### Staged documentation, not full scan

Full-project documentation is prohibitively expensive for large codebases. Instead, do a staged approach:

**Stage 0a: Skeleton scan** (minutes, not hours)

- Directory structure, file count, language breakdown
- Package dependencies (package.json, requirements.txt, etc.)
- CI/CD configuration if present
- Output: `knowledge/project-overview.md` (structural, not semantic)

**Stage 0b: Targeted deep scan** (scoped to user’s idea)

- User says “add OAuth support” → scan only auth-related files, API routes, middleware
- Use file names, imports, and grep to identify relevant code
- Output: `knowledge/auth.md` (generated from existing code, not from spec)

**Stage 0c: Interface extraction**

- For the files identified in 0b, extract public interfaces (function signatures, API routes, data models)
- Output: Interface stubs that the dependency graph can reference

This means the system doesn’t need to understand the entire codebase — just the parts the user’s idea touches. As work proceeds and the agent encounters dependencies on other parts of the codebase, it does targeted scans on demand and adds new knowledge docs.

-----

## 9. Ambiguity Gate: Artifact-Anchored Scoring

### Replace LLM judgment with artifact existence checks

Instead of having the LLM score its own confidence (circular, unreliable, inconsistent across prompt variations), anchor the ambiguity score to concrete artifacts:

```
Goal clarity (weight 0.4):
  1.0 = Written acceptance test exists for primary goal
  0.7 = Scenario-based AC exists (see Section 4)
  0.5 = Qualitative description exists ("it should feel fast")
  0.2 = Only vague direction ("something for podcasts")
  0.0 = No goal stated

Constraints (weight 0.3):
  1.0 = Harness constraints defined + danger zones listed
  0.7 = Major constraints enumerated but not formalized
  0.3 = "Use our existing stack" (implicit, not explicit)
  0.0 = No constraints discussed

Success criteria (weight 0.3):
  1.0 = Measurable criteria with numbers ("< 1s load time")
  0.7 = Scenario-based criteria (user can do X → Y happens)
  0.4 = Qualitative criteria ("it should be easy to use")
  0.0 = "I'll know it when I see it"
```

This scoring is deterministic — either the artifact exists or it doesn’t. The interviewer agent’s job is to keep asking questions until enough artifacts exist to push the score above threshold. No LLM self-assessment needed.

-----

## 10. Job Sizing: Artifact Count, Not Token Count

### Replace “≤50% context” with measurable proxies

Since the agent can’t reliably estimate its own token usage, define job size in terms of observable outputs:

```markdown
## Job size constraints
max_files_touched: 5      # files created or modified
max_test_cases: 10         # tests to write
max_interfaces_changed: 2  # public API changes
max_turns: 40              # turn budget (see Section 5)
```

During decomposition, the decomposition agent estimates these for each job. If a job exceeds any limit, it should have been split further. These are checkable at runtime — the agent can count files it’s touched and tests it’s written.

The decomposition question changes from “Can you complete this in ≤50% context?” (unanswerable) to “Will this require modifying more than 5 files?” (answerable by examining the spec and codebase structure).

-----

## Summary: Priority-Ordered Improvements

|# |Improvement                                         |Addresses                           |Effort|Impact|
|--|----------------------------------------------------|------------------------------------|------|------|
|1 |Artifact-anchored ambiguity scoring                 |Foundation: circular self-eval      |Low   |High  |
|2 |Artifact-count job sizing                           |Foundation: unmeasurable job size   |Low   |High  |
|3 |Scenario + anti-scenario acceptance criteria        |Taste gap in autonomous execution   |Medium|High  |
|4 |Confidence-tagged knowledge writes                  |Memory drift across jobs            |Low   |Medium|
|5 |Bootstrap compiler (compiled context view)          |Context pollution at bootstrap      |Medium|High  |
|6 |Author/critic session split for eval                |Self-validation trap                |Medium|High  |
|7 |In-session checkpointing at turn 30                 |35-minute degradation wall          |Medium|High  |
|8 |Three typed cascade checks                          |Vague cascade mechanism             |Low   |Medium|
|9 |Steer reclassification (context/directive/emergency)|Steer race condition + ambiguity    |Low   |Medium|
|10|Staged brownfield onboarding                        |Phase 0 bootstrapping cost          |Medium|High  |
|11|Property-based testing as eval stage 1.5            |Self-generated test blind spots     |Medium|Medium|
|12|Divergent mockup generation                         |UI taste during autonomous execution|Medium|Medium|

Items 1-2 are foundation fixes — do these first. Items 3-7 are the highest-impact improvements for enabling genuine 12-hour autonomous runs. Items 8-12 are important but can iterate.
