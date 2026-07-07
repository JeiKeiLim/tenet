---
id: TASK-011
title: Better interview — divide and conquer
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
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
