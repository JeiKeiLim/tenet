---
id: TASK-018
title: tenet status and MCP tool misalign
status: Done
assignee: []
created_date: '2026-07-07 02:17'
updated_date: '2026-07-07 02:17'
labels: []
dependencies: []
priority: low
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent couldn't see job IDs through tenet MCP tool to clean up stale jobs. Delivered (v26.6.7): tenet_get_status now takes view='summary'|'queue' with optional include_blocked. Queue lists non-terminal jobs with id, type, status, name, age_ms, stale.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 tenet_get_status supports queue view with job details
- [ ] #2 Agent can see and cancel stale pending jobs via MCP
<!-- AC:END -->
