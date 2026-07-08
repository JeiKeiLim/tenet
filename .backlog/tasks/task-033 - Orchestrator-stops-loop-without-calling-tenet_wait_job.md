---
id: TASK-033
title: Orchestrator stops loop without calling tenet_wait_job
status: To Do
assignee: []
created_date: '2026-07-07 22:11'
labels:
  - bug
  - orchestrator
dependencies: []
priority: high
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When using qwen3.6 27b as orchestrator, it sometimes says it will wait for a job but never calls the tenet_wait_job MCP tool — it just stops doing nothing. This breaks the tenet loop. Need to investigate root cause and find a way to prevent this (e.g. forcing the tool call, adding validation, or restructuring the loop).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Identify root cause of orchestrator skipping tenet_wait_job
- [ ] #2 Implement a mechanism to prevent the orchestrator from stopping without calling wait
- [ ] #3 Verify fix works with qwen3.6 27b or similar weaker models
<!-- AC:END -->
