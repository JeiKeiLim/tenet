---
id: TASK-012
title: Job waiting loop delegating to sub-agent
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
labels: []
dependencies: []
priority: low
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed qwen3.6 delegating job waiting loop to sub-agent, which is clever context management. Evaluate whether this pattern should be formalized, and whether indefinite wait (remove 120s timeout) makes sense.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Sub-agent delegation pattern is evaluated for formal support
- [ ] #2 Indefinite wait vs timeout behavior is decided
- [ ] #3 Pattern works across opencode, codex, and claude code
<!-- AC:END -->
