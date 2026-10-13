---
id: TASK-040
title: Fix job_wait default timeout — agent spins when wait_seconds is omitted
status: Done
assignee: []
created_date: '2026-07-13 04:00'
updated_date: '2026-10-13 00:36'
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
- [x] #2 Or alternatively, agent instructions are updated to always pass wait_seconds explicitly
- [x] #3 No tight retry loop when wait_seconds is omitted
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified): Resolved via the AC#2 alternative path. Shipped: documented instant-return contract in src/mcp/tools/tenet-job-wait.ts (description: By default returns instantly with the job state; Use 0 or omit for instant response; wait_seconds ?? 0) plus skill-side guidance from commit 5a5b315 (sub-agent delegation default for the wait span, bounded backoff 30->120s, next_args wait_seconds:30 from all four dispatching tools) closing the inline-poll escape hatches (AC#3). AC#1's 30s default was deliberately NOT taken: instant-check-on-omission is documented, load-bearing behavior, and a server-side default would conflict with the shipped contract and the parked TASK-037 verdict - left unchecked for honesty. If the spin ever recurs with a weak orchestrator, file it under the TASK-033/034 weak-model reliability family with a transcript, per TASK-037's measure-first rule.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Resolved via its own AC#2 path: instant-return job_wait contract plus skill-side delegation guidance removed the tight-poll spin; the 30s default (AC#1) was a deliberate rejection. Closed as Done in the 2026-10-13 backlog cleanup.
<!-- SECTION:FINAL_SUMMARY:END -->
