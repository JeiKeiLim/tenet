---
id: TASK-040
title: Fix job_wait default timeout — agent spins when wait_seconds is omitted
status: To Do
assignee: []
created_date: '2026-07-13 04:00'
labels:
  - orchestrator
  - agent
  - bug
dependencies: []
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When an agent calls job_wait without passing wait_seconds, the tool returns immediately instead of waiting. The agent then incorrectly believes it waited ~60s and keeps retrying in a tight loop. This is a tool-calling discipline issue: job_wait should either have a sensible default timeout (e.g. 30s) or the agent should be instructed to always pass wait_seconds. Observed behavior: agent says 'let's wait 60s' but job_wait returns instantly, agent retries immediately.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 job_wait with no wait_seconds defaults to a reasonable timeout (e.g. 30s) instead of returning instantly
- [ ] #2 Or alternatively, agent instructions are updated to always pass wait_seconds explicitly
- [ ] #3 No tight retry loop when wait_seconds is omitted
<!-- AC:END -->
