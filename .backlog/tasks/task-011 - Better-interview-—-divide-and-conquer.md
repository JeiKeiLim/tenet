---
id: TASK-011
title: Better interview — divide and conquer
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 21:49'
labels: []
dependencies: []
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Current interview phase treats entire request with a single process regardless of size. Use divide-and-conquer: split user requests into sub-requests (like DAG but at interview level). Also review whether the question category list is generally suitable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Interview phase detects when a request should be split into sub-requests
- [ ] #2 Sub-requests are analyzed independently
- [ ] #3 Question categories are reviewed and validated against references (bmad-method, ouroboros harness)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DECISION (2026-10-13 backlog cleanup): user reviewed and explicitly chose to KEEP this open despite the recorded Socratic-works stance and the audit's close recommendation - divide-and-conquer interviewing remains a wanted improvement direction. Do not re-flag as stale in future audits without new discussion. The measure-first objection stands for prioritization only: collect a real large-request interview failure before scheduling.
<!-- SECTION:NOTES:END -->
