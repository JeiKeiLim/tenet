---
id: TASK-004
title: Critic model selection
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
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
