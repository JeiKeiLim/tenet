# Phase 01: Interview

This reference defines the mandatory interview phase for Tenet Full mode. Read and follow these instructions exactly to ensure project crystallization success.

## 1. Output File Path
The interview transcript MUST be saved before proceeding to the next phase:
- Path: `.tenet/interview/{date}-{feature}.md` (e.g. `.tenet/interview/2026-04-08-oauth.md`)
- `{date}` is today's ISO date (YYYY-MM-DD), `{feature}` is a short slug derived from the project/feature name (e.g. "oauth", "payments", "user-dashboard")
- Determine the feature slug early in the interview (from the user's description of what they want to build). Use lowercase, hyphen-separated words.
- For subsequent rounds in the same session: append to the same file (add a new `## Round N` section)
- For a new session on the same feature: create a new file with today's date — `resolveLatest()` will pick the most recent

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

## 3. Clarity Gate Mechanics
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

## 4. Interview Transcript Format
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

## Summary
[Concise summary of project agreement]
```

## 5. User Interaction Method
- **ALWAYS prefer interactive prompts** (question dialog / modal) over inline text when asking interview questions.
- Use the host agent's question/dialog tool (e.g. `AskUserQuestion`) to present each question individually and wait for the user's response.
- Do NOT dump all questions as a text block and expect the user to answer inline — this creates a poor experience and makes it easy to miss questions.
- If the host agent does not support interactive prompts, fall back to asking one question at a time in regular text and waiting for a response before proceeding to the next question.

## 6. YOLO Mode

**NEVER assume yolo mode.** The default is ALWAYS interactive. Yolo mode ONLY activates when the user explicitly says one of: "yolo", "skip questions", "decide everything", "don't ask me questions."

If you think the user might want yolo mode but they didn't explicitly say it, **ask them**: "Would you like me to enter yolo mode and make all upfront decisions without asking? [Yes / No]"

When the user triggers YOLO mode, **confirm before activating**: "Entering yolo mode — I will make all decisions during interview, spec, and decomposition without asking you. You'll still confirm before autonomous execution starts. Proceed?"

Once confirmed, the agent:
- Skips interactive interview questions — makes all decisions autonomously based on codebase analysis and brownfield scan
- Still writes the interview transcript with decisions made and assumptions
- Still runs `tenet_validate_clarity()` — if clarity is low, the agent fills gaps by reading the codebase rather than asking the user
- Still generates spec, scenarios, and decomposition — but without user confirmation at each step
- YOLO mode ends at the pre-execution confirmation gate — the user always confirms before autonomous execution begins

## 7. Research During Interview

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
- Call `tenet_update_knowledge(type="knowledge", title="research-{topic}")` with:
  - What was researched and why
  - Key findings (capabilities, limitations, compatibility)
  - Recommended approach based on findings
  - Confidence tag: `[research-verified]` or `[research-inconclusive]`
- File lands in `.tenet/knowledge/` for future agents to reference

**Example research triggers during interview:**
Files are auto-dated by `tenet_update_knowledge` (e.g., `2026-04-09_research-stripe-connect.md`):
- "I want to use Stripe Connect for marketplace payments" → `title="research-stripe-connect"` — API, onboarding flow, payout mechanics
- "Can we do real-time collaboration like Google Docs?" → `title="research-realtime-collaboration"` — CRDTs, WebSocket scaling, operational transforms
- "The app needs to work offline" → `title="research-offline-first"` — service workers, IndexedDB, sync strategies

**Do NOT skip research to keep the interview fast.** A 5-minute research pause prevents a multi-hour implementation mistake.

## 8. Anti-Skip Enforcement
- Do NOT proceed to spec or harness generation until the transcript file is written and the clarity gate passes.
- If the user says "just build it" (without triggering YOLO mode), you MUST still ask the minimum required questions and record the answers.

## 9. Adaptive Interview Length
- **Greenfield project:** 2-3 rounds, 8-15 questions total.
- **Brownfield/known scope:** 1-2 rounds, 5-8 questions total.
- **Standard mode (quick clarification):** 1 round, 3-5 questions total.
