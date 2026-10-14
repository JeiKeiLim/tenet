---
id: TASK-004
title: Critic model selection
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
labels: []
dependencies: []
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add per-critic model selection so correlated blind spots don't survive. Dispatch critics with different models for diversity. Consider frontier model critic review gate, dynamic course correction, and PM agent integration. v26.7.0 shipped per-critic full_context precursor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Critics can be dispatched with different models per critic
- [ ] #2 Model selection is configurable by critic type
- [ ] #3 Frontier model critic review gate is available as option
- [ ] #4 Configuration management for growing config complexity is addressed
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SCOPE NOTE (2026-10-13 cleanup): core scope is per-critic model selection + the frontier review gate (no per-critic model field exists today: src/core/critic-roster.ts:100-108; every critic dispatches on one agent). The PM-agent consider-item is owned by TASK-006 - drop it when scheduling this task.
<!-- SECTION:NOTES:END -->
