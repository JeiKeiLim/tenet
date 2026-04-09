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
- Call `tenet_update_knowledge(type="knowledge", title="research-{topic}")` for each research topic
- Include: what was researched, key findings, limitations discovered, recommended approach
- Tag with `[research-verified]` confidence level
- These become reference material for the spec AND for future dev agents

**Example pre-spec research:**
Files are auto-dated by `tenet_update_knowledge` (e.g., `2026-04-09_research-nextjs-auth-patterns.md`):
- `title="research-nextjs-auth-patterns"` → How to implement auth with the chosen stack, session management options
- `title="research-stripe-connect-api"` → API limits, webhook requirements, test mode setup
- `title="research-postgresql-jsonb-indexing"` → Performance characteristics for the planned schema design

**Do NOT skip this step.** Writing a spec without researching the technologies leads to specs that can't be implemented, or implementations that use the wrong patterns.

## 1. Exact File Paths
CRITICAL: Do NOT write to root `.tenet/`. Use feature-scoped `$date-$feature.md` naming:
- **SPEC**: `.tenet/spec/{date}-{feature}.md` (e.g. `.tenet/spec/2026-04-08-oauth.md`)
- **HARNESS**: `.tenet/harness/current.md` (Update the existing template — project-wide, not feature-scoped)
- **SCENARIOS**: `.tenet/spec/scenarios-{date}-{feature}.md` (e.g. `.tenet/spec/scenarios-2026-04-08-oauth.md`)

Use the same `{feature}` slug established during the interview phase. `{date}` is today's ISO date (YYYY-MM-DD).

## 2. Spec Requirements (`.tenet/spec/{date}-{feature}.md`)
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
- [ ] `.tenet/spec/{date}-{feature}.md` exists with all 8 required sections.
- [ ] `.tenet/harness/current.md` is updated, not the original template.
- [ ] `.tenet/spec/scenarios-{date}-{feature}.md` has 3+ scenarios and 3+ anti-scenarios.
- [ ] Spec references a mockup from `.tenet/visuals/`.
- [ ] Harness danger zones are populated.

**Do NOT proceed to decomposition until all three files are written and this checklist passes.**