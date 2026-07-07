---
id: TASK-019
title: tenet status job ordering
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tenet status showed unsorted jobs. Delivered (v26.6.8): sorts by status priority then dag_id in natural/numeric order, falling back to created_at for ad-hoc jobs. Shared compareJobsByPlan drives both CLI table and job-queue.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Jobs sorted by status priority then dag_id natural order
- [ ] #2 Both CLI and job-queue.md use same sort logic
<!-- AC:END -->
