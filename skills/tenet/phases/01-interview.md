# Phase 01: Interview

This reference defines the mandatory interview phase for Tenet Full mode. Read and follow these instructions exactly to ensure project crystallization success.

## 1. Output File Path
The interview transcript MUST be saved before proceeding to the next phase:
- Path: `.tenet/interview/interview.md`
- For subsequent rounds: `.tenet/interview/interview-round-N.md` (where N is the round number)

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

## 5. Anti-Skip Enforcement
- Do NOT proceed to spec or harness generation until the transcript file is written and the clarity gate passes.
- If the user says "just build it," you MUST still ask the minimum required questions and record the answers.

## 6. Adaptive Interview Length
- **Greenfield project:** 2-3 rounds, 8-15 questions total.
- **Brownfield/known scope:** 1-2 rounds, 5-8 questions total.
- **Standard mode (quick clarification):** 1 round, 3-5 questions total.
