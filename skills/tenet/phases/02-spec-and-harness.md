# Phase 2: Spec and Harness Generation

Crystallize the project requirements into strict, actionable files. This phase ensures the agent has a source of truth before building.

## 1. Exact File Paths
CRITICAL: Do NOT write to root `.tenet/`. Use these exact paths:
- **SPEC**: `.tenet/spec/spec.md`
- **HARNESS**: `.tenet/harness/current.md` (Update the existing template)
- **SCENARIOS**: `.tenet/spec/scenarios.md`

## 2. Spec Requirements (`.tenet/spec/spec.md`)
The spec must include:
- **Purpose**: 1 to 3 sentence project goal from the interview.
- **Tech Stack**: Confirmed choices with specific versions.
- **API Endpoints**: Table with Method, Path, Auth, and Description.
- **Database Schema**: Table per entity with Column, Type, and Constraints.
- **Design Direction**: Explicit reference to the chosen mockup in `.tenet/visuals/`.
- **Auth Flow**: Step by step numbered list.
- **Success Criteria**: Numbered, measurable, and testable outcomes.
- **Out of Scope**: List of features or behaviors the project will NOT implement.

## 3. Harness Requirements (`.tenet/harness/current.md`)
Update the `tenet init` template with project-specific values:
- **Formatting & Linting**: Specify tools like `ruff`, `eslint`, or `prettier`.
- **Testing**: Define framework and coverage targets.
- **Architecture Rules**: Add project-specific structural constraints.
- **Code Principles**: Append project-specific values to the defaults.
- **Danger Zones**: List paths that must never be modified.
- **Iron Laws**: Define project invariants, such as mandatory password hashing.

## 4. Scenarios (`.tenet/spec/scenarios.md`)
Define success and failure shapes:
### Scenarios (Success)
1. [User story with concrete steps and expected outcome]
### Anti-Scenarios (Failure)
1. [Concrete failure mode to prevent]

## 5. Validation Checklist
Verify these before proceeding:
- [ ] `.tenet/spec/spec.md` exists with all 8 required sections.
- [ ] `.tenet/harness/current.md` is updated, not the original template.
- [ ] `.tenet/spec/scenarios.md` has 3+ scenarios and 3+ anti-scenarios.
- [ ] Spec references a mockup from `.tenet/visuals/`.
- [ ] Harness danger zones are populated.

**Do NOT proceed to decomposition until all three files are written and this checklist passes.**