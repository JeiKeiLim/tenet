---
id: TASK-026
title: Journal improvement — run path resolution
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent wrote journal at top-level .tenet/journal/ instead of .tenet/runs/run-slug/journal/. Delivered (v26.7.2): root cause was mechanism gap in getRunPath. Fixed by walking job ancestry with 5-hop bound and visited-set cycle guard.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Ungrounded critic journal entries land in correct run journal/
- [ ] #2 Job ancestry walk resolves run path correctly
<!-- AC:END -->
