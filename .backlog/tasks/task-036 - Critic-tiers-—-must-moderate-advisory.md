---
id: TASK-036
title: Critic tiers — must / moderate / advisory
status: Done
assignee: []
created_date: '2026-07-07 22:12'
updated_date: '2026-10-13 21:50'
labels:
  - feature
  - critics
  - orchestrator
dependencies: []
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce critic levels/tiers to give the orchestrator flexibility without skipping mandatory critics. Three tiers: 'must' (blocking — all must pass), 'moderate' (should pass but can proceed with caution), 'advisory' (informational, non-blocking). This allows the orchestrator to make smart decisions about when to proceed while still enforcing hard gates for critical critics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Define critic tier system (must / moderate / advisory)
- [ ] #2 Orchestrator respects tier: 'must' critics are blocking, 'moderate' and 'advisory' are non-blocking
- [ ] #3 Backward compatible — existing critics default to 'must'
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (user decision, backlog cleanup): wont-do. Tiers would reverse the deliberate all-must-pass severity rule (every configured critic must pass; the blocking-finding resume gate enforces the same configured set via expected_eval_stages), and reintroduce orchestrator judgment calls about proceeding past failed critics - the exact weak-orchestrator failure mode TASK-035 was filed about and which shipped prompt controls now forbid. The flexibility tiers would provide already exists two ways: roster choice IS the tier (per-project .tenet/critics.json + per-run Critic Tailoring - a finding type that should not block is simply not rostered), and report-only jobs are the advisory channel. No run evidence on the need side: recorded incidents show critics catching real product bugs (podany credit-gate bypass, duration-omission bypass), never a case where proceeding past a failed critic would have been right. NOTE: TASK-035's closure note pointed here as the tier exploration's continuation - with this closure that line ends entirely; the only reopen path for tier-like behavior is TASK-037's measure-first shape (critic auto-dispatch + deliverable-quality check) if real weak-model failure data ever appears.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed as wont-do: all-must-pass is the deliberate severity rule; roster configuration + report-only jobs already provide the tier flexibility.
<!-- SECTION:FINAL_SUMMARY:END -->
