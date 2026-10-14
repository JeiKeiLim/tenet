---
id: TASK-013
title: Critic output as JSON
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
labels: []
dependencies: []
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Opencode often struggles to find critic output. Consider having critics write JSON format verdict first, then write findings incrementally for partial results. Address file storage concerns for intermediate JSON files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Critics output verdict in JSON format as primary output
- [ ] #2 Incremental findings writing provides partial results
- [ ] #3 JSON file storage strategy addresses cleanup concerns
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified) as superseded, not implemented as specified: the Opencode-discoverability incident is resolved by the shipped JSON-verdict system - the END-shape verdict (passed/stage/findings JSON) is mandated in the critic preambles (src/mcp/tools/tenet-start-eval.ts:82 and the other two preambles) and parsed by the shared parser (src/core/rubric.ts, hardened through the 26.7.x-26.8.x rubric recovery work, with a production golden test at src/core/rubric.production.test.ts). Partial results are covered by the stronger v26.6.7 retry/split policy (TASK-024, Done). The deeper tenet_report redesign is a recorded parked decision under TASK-037 (Done, measure first).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded: the shipped rubric-JSON critic verdict system covers the task's goal (machine-discoverable critic output); deeper report redesign stays parked under TASK-037's measure-first rule.
<!-- SECTION:FINAL_SUMMARY:END -->
