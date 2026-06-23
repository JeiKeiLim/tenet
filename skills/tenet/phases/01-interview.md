# Phase 01: Interview

This reference defines the mandatory interview phase for Tenet Full mode. Read and follow these instructions exactly to ensure project crystallization success.

## 1. Run Identity And Output File Path
The interview transcript MUST be saved before proceeding to the next phase:
- Run slug: `{date}-{feature}` (e.g. `2026-04-08-oauth`)
- Run path: `.tenet/runs/{date}-{feature}/`
- Transcript path: `.tenet/runs/{date}-{feature}/interview.md`
- `{date}` is today's ISO date (YYYY-MM-DD), `{feature}` is a short slug derived from the project/feature name (e.g. "oauth", "payments", "user-dashboard")
- Determine the feature slug early in the interview (from the user's description of what they want to build). Use lowercase, hyphen-separated words.
- Create `.tenet/runs/{date}-{feature}/research/`, `.tenet/runs/{date}-{feature}/journal/`, and `.tenet/runs/{date}-{feature}/visuals/` before writing run artifacts.
- For subsequent rounds in the same session: append to the same `interview.md` file (add a new `## Round N` section).
- For a new session on the same feature: create a new run directory with today's date. Feature-only lookup exists only as a legacy compatibility fallback.

## 2. Mandatory Question Categories
Ask at least one question from each category in the first round.

| Category | Goal |
| :--- | :--- |
| **Purpose** | Identify the core problem, user personas, and success metrics. |
| **Scope** | Define boundaries and explicitly state what is out of scope. |
| **Technical Constraints** | Confirm tech stack, existing codebase, performance, and deployment. |
| **User Experience** | Map key workflows, UI/UX expectations, and error handling. |
| **Data** | Define storage requirements, schema, persistence, and migrations. |
| **Security** | Establish auth models, sensitive data handling, and access controls. |
| **Integration** | List external APIs, services, and third-party dependencies. |
| **Edge Cases** | Address failure modes, rate limits, and concurrent user behavior. |

## 3. Delivery Mode Gate

In Full mode, before calling `tenet_validate_clarity()`, ask one standalone delivery-mode question.

Required prompt content:
- Explain `autonomous`: one end-to-end run after pre-execution confirmation.
- Explain `agile`: sliced delivery with an initial plan-checkpoint and use-checkpoints after each slice.
- Ask the user to choose `autonomous` or `agile`.

The delivery-mode question MUST NOT be combined with stack, scope, UX, or other defaults.

Valid outcomes:
- User chooses `autonomous` or `agile`; record `Selection basis: explicit_user_choice`.
- User responds with uncertainty or no preference after seeing both options; select `autonomous` and record `Selection basis: defaulted_after_explicit_choice_prompt`.
- YOLO mode was explicitly confirmed; choose deliberately and record `Selection basis: yolo_agent_decision`.

Invalid outcomes:
- No standalone delivery-mode question was asked.
- Delivery mode was buried in a multi-part defaults bundle.
- User said "okay", "sounds good", or equivalent to unrelated defaults.
- Pre-execution confirmation was used as retroactive delivery-mode approval.

## 4. Clarity Gate Mechanics
After writing the interview transcript, call `tenet_validate_clarity()` to dispatch an independent agent that scores the transcript. Do NOT compute the score yourself.

The validation agent uses these scoring dimensions:

**Scoring Dimensions:**
- **Goal Clarity (weight 0.4):**
  - 1.0: User confirmed acceptance criteria with concrete examples.
  - 0.5: User gave general goals but no concrete criteria.
  - 0.0: Goals unclear or contradictory.
- **Constraint Clarity (weight 0.3):**
  - 1.0: Tech stack, deployment, and security requirements all confirmed.
  - 0.5: Some constraints known, others assumed.
  - 0.0: No constraints discussed.
- **Success Criteria Clarity (weight 0.3):**
  - 1.0: Measurable scenarios defined ("user can X, system does Y").
  - 0.5: Vague criteria ("it should work well").
  - 0.0: No criteria discussed.

**Gate Logic:**
- `Clarity = (Goal * 0.4) + (Constraints * 0.3) + (Success * 0.3)`
- **GATE: Clarity >= 0.8 to proceed.**
- If Score < 0.8: The validation result includes specific gaps. Ask follow-up questions targeting those gaps, update the transcript, and call `tenet_validate_clarity()` again.

## 5. Interview Transcript Format
The saved file MUST use this structure:

```markdown
# Interview: [Project Name]

Date: [ISO date]
Mode: Full
Rounds: [N]

## Clarity Score
- Goal: [Score] (weight 0.4)
- Constraints: [Score] (weight 0.3)  
- Success criteria: [Score] (weight 0.3)
- **Total: [Total Score] / 0.8 required**

## Round [N]

### Questions Asked
1. [Question text]
   > [User's answer]

2. [Question text]
   > [User's answer]

### Decisions Made
- [Decision 1]
- [Decision 2]

### Remaining Ambiguities
- [Ambiguity 1]

## Delivery Mode Decision
- Prompt shown: [exact text or concise summary]
- User response: [exact response, or YOLO confirmation]
- Selected delivery_mode: autonomous|agile
- Selection basis: explicit_user_choice|defaulted_after_explicit_choice_prompt|yolo_agent_decision

## Summary
[Concise summary of project agreement]
```

## 6. User Interaction Method
- **ALWAYS prefer interactive prompts** (question dialog / modal) over inline text when asking interview questions.
- Use the host agent's question/dialog tool (e.g. `AskUserQuestion`) to present each question individually and wait for the user's response.
- Do NOT dump all questions as a text block and expect the user to answer inline — this creates a poor experience and makes it easy to miss questions.
- If the host agent does not support interactive prompts, fall back to asking one question at a time in regular text and waiting for a response before proceeding to the next question.

## 7. YOLO Mode

**NEVER assume yolo mode.** The default is ALWAYS interactive. Yolo mode ONLY activates when the user explicitly says one of: "yolo", "skip questions", "decide everything", "don't ask me questions."

If you think the user might want yolo mode but they didn't explicitly say it, **ask them**: "Would you like me to enter yolo mode and make all upfront decisions without asking? [Yes / No]"

When the user triggers YOLO mode, **confirm before activating**: "Entering yolo mode — I will make all decisions during interview, spec, and decomposition without asking you. You'll still confirm before autonomous execution starts. Proceed?"

Once confirmed, the agent:
- Skips interactive interview questions — makes all decisions autonomously based on codebase analysis and brownfield scan
- Still writes the interview transcript with decisions made and assumptions
- Still records `## Delivery Mode Decision` with `Selection basis: yolo_agent_decision`
- Still runs `tenet_validate_clarity()` — if clarity is low, the agent fills gaps by reading the codebase rather than asking the user
- Still generates spec, scenarios, and decomposition — but without user confirmation at each step
- YOLO mode ends at the pre-execution confirmation gate — the user always confirms before autonomous execution begins

## 8. Research During Interview

When the user's requirements involve unfamiliar technologies, complex integrations, or feasibility questions, conduct **targeted research** before continuing the interview.

**Triggers for research:**
- User mentions a technology/library/API the agent hasn't confirmed it understands
- User asks "is it possible to..." or "can we..." about a specific capability
- User describes a requirement that involves complex system integration
- Brownfield project uses frameworks or patterns the agent hasn't encountered

**How to research:**
1. Use `WebSearch` and `WebFetch` to investigate the technology, API, or approach
2. Read existing codebase files to understand current patterns (brownfield)
3. Check framework documentation for feasibility and best practices
4. Identify limitations, gotchas, and alternative approaches

**Save research results:**
- Write raw or run-specific research to `.tenet/runs/{date}-{feature}/research/{topic}.md` with:
  - What was researched and why
  - Key findings (capabilities, limitations, compatibility)
  - Recommended approach based on findings
  - Confidence tag: `[scanned-not-verified]` (unproven) or `[decision-only]` (adopted)
- Promote only durable, reusable facts to top-level `.tenet/knowledge/` via `tenet_update_knowledge(type="knowledge", title="{concern}")`.

**Example research triggers during interview:**
- "I want to use Stripe Connect for marketplace payments" -> `.tenet/runs/{run_slug}/research/stripe-connect.md` — API, onboarding flow, payout mechanics
- "Can we do real-time collaboration like Google Docs?" -> `.tenet/runs/{run_slug}/research/realtime-collaboration.md` — CRDTs, WebSocket scaling, operational transforms
- "The app needs to work offline" -> `.tenet/runs/{run_slug}/research/offline-first.md` — service workers, IndexedDB, sync strategies

**Do NOT skip research to keep the interview fast.** A 5-minute research pause prevents a multi-hour implementation mistake.

## 9. Anti-Skip Enforcement
- Do NOT proceed to spec or harness generation until the transcript file is written and the clarity gate passes.
- If the user says "just build it" (without triggering YOLO mode), you MUST still ask the minimum required questions and record the answers.
- In Full mode, do NOT proceed to spec unless `## Delivery Mode Decision` exists and records a valid selection basis.

## 10. Adaptive Interview Length
- **Greenfield project:** 2-3 rounds, 8-15 questions total.
- **Brownfield/known scope:** 1-2 rounds, 5-8 questions total.
- **Standard mode (quick clarification):** 1 round, 3-5 questions total.

## 11. Crystallize Project Doctrine (greenfield only)

When the project is **greenfield** — i.e. the context bootstrap gate deferred `.tenet/project/**` because there was no implementation to scan — author the initial project doctrine here, from the interview decisions. This is the counterpart to the brownfield bootstrap synthesis: brownfield gets doctrine by scanning code, greenfield gets it from the interview.

Skip this section entirely for **brownfield** projects — bootstrap already synthesized `project/` from the live codebase, and this section would just overwrite it.

Run this after the clarity gate (§ 4) passes and the transcript is written:

1. Confirm the run directory exists with its subdirectories (§ 1): `.tenet/runs/{run_slug}/` with `research/`, `journal/`, `visuals/`.
2. Write each required project doc from the interview record — concrete decisions, never "TBD" / "determined later" placeholders:
   - `.tenet/project/overview.md` — purpose, user personas, success metrics, current status (greenfield; implementation pending).
   - `.tenet/project/product.md` — user-facing behavior agreed in the interview.
   - `.tenet/project/architecture.md` — tech stack and runtime/architecture decisions confirmed in the interview.
   - `.tenet/project/testing.md` — testing strategy and quality approach agreed in the interview.
   - `.tenet/project/design.md` — interaction-surface and design conventions agreed in the interview (language, feedback, accessibility, visual system when relevant).
3. These are the initial durable baseline. Later phases may refine them, but they must capture real interview decisions now so downstream jobs (`tenet_compile_context`, eval) read trustworthy doctrine instead of placeholders.

After this, the greenfield bootstrap deferral is satisfied on real doctrine. Do not edit `.tenet/project/**` during normal implementation jobs; suggest doctrine updates via the run journal instead.
