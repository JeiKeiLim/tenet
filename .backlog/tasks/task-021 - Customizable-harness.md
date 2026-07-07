---
id: TASK-021
title: Customizable harness
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tenet uses 3 critics; make it configurable. Delivered: critics are now a project artifact in .tenet/critics.json. Phase 1 (enable/disable) and Phase 2 (custom prompts) shipped together.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 3 built-in critics (code/test/interaction-e2e) are configurable
- [ ] #2 Custom critics can be added with prompts under .tenet/critics/*.md
- [ ] #3 Blocking-finding resume gate reads expected_eval_stages
<!-- AC:END -->
