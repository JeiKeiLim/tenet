---
id: TASK-025
title: Knowledge update bug investigation
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since v26.6.1, tenet_update_knowledge tool didn't seem to write knowledge documents under .tenet/knowledge/. Closed (not a bug): orchestrator was writing type='journal' (tool default), which correctly lands in .tenet/runs/<run>/journal/, not .tenet/knowledge/.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root cause identified: tool default type=journal routes to run journal, not knowledge
- [ ] #2 06-evaluation.md updated to not claim eval records land in .tenet/knowledge/
<!-- AC:END -->
