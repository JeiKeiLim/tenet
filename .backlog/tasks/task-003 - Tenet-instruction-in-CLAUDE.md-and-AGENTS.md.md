---
id: TASK-003
title: Tenet instruction in CLAUDE.md and AGENTS.md
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
labels: []
dependencies: []
priority: medium
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add tenet orchestration rules to CLAUDE.md and AGENTS.md so weaker models follow them better (frontier models already follow via tenet skill). Mark with <!-- Tenet v26.x.x instruction block --> boundaries to avoid touching user instructions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tenet orchestration rules are appended to CLAUDE.md and AGENTS.md
- [ ] #2 Rules are wrapped in clearly marked instruction blocks
- [ ] #3 User's own instructions are preserved untouched
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PARKED (2026-10-13 cleanup annotation): per docs/planning/18_model_tier_and_worker_context.md decision 7, the shipped runtime orchestrator role-preamble (src/mcp/tools/tenet-compile-context.ts:243) is the primary mechanism; the CLAUDE.md/AGENTS.md instruction block is the heavy fallback - build ONLY if a real run shows the preamble being ignored. Do not mistake this task for unstarted live work.
<!-- SECTION:NOTES:END -->
