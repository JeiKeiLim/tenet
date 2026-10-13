---
id: TASK-034
title: Use worker heartbeat signal instead of relying on job_wait timeout
status: To Do
assignee: []
created_date: '2026-07-07 22:11'
updated_date: '2026-10-13 00:42'
labels:
  - orchestrator
  - worker
  - reliability
dependencies: []
priority: medium
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The worker appears to send heartbeats regularly. Currently the orchestrator relies on its own ability to keep calling job_wait MCP tool with a maximum 120s timeout to determine if the worker is alive. Instead, we should use the worker's heartbeat signal to track liveness, which is more reliable and doesn't depend on the orchestrator's tool-calling discipline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Verify that worker sends heartbeat signals
- [ ] #2 Design heartbeat-based liveness detection mechanism
- [ ] #3 Replace or supplement job_wait timeout with heartbeat monitoring
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PREMISE CORRECTION (2026-10-13 cleanup audit): the observed heartbeats are the owning server's 2s setInterval writes (src/core/job-manager.ts:422-431), not worker-emitted signals - workers have no heartbeat mechanism. The claimed benefit was refuted by TASK-037's no-push finding. Sole residual: earlier hung-worker detection - gate on measured worker-hang data (none exists today).
<!-- SECTION:NOTES:END -->
