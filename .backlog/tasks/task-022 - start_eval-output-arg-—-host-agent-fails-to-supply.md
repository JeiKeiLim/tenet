---
id: TASK-022
title: start_eval output arg — host agent fails to supply
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Host agent got stuck looping on tenet_start_eval requiring 'output' parameter. Delivered (v26.7.2): output is now optional (default {}), so stuck agent can't wedge itself. Critics just get less to chew on.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 output parameter is optional with default {}
- [ ] #2 Regression test locks omitted-output dispatch path
<!-- AC:END -->
