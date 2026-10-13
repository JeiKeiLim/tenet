---
id: TASK-001
title: Weak model critics investigation
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
labels: []
dependencies: []
priority: medium
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When planning with frontier model and executing with less capable model (qwen3.6, deepseek-v4-flash), the weaker model tends to pass all critics while frontier model finds issues. Investigate whether this is a prompt issue or a capability limitation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Root cause identified: prompt issue vs capability limitation
- [ ] #2 Recommendation documented for addressing weak model critic behavior
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified) as superseded, not implemented: diagnosis-only task whose recommendation of record already exists - docs/planning/18_model_tier_and_worker_context.md:62 decision 8 (weak-model critic concern stays parked; covered today by custom critics; future multi-model/dynamic critics will address it; do not re-litigate without new evidence). The prompt-vs-capability verdict is inherited by open TASK-045 (note added there); the forward remedy space is owned by open TASK-004 (per-critic model selection) and TASK-045 (tier-aware critic splitting). Prompt-side mitigation already ships: zero-findings anti-rubber-stamp rule (src/mcp/tools/tenet-start-eval.ts:56-57; skills/tenet/phases/06-evaluation.md:89). If a real weak-model run ever blocks, attach the evidence to TASK-004/TASK-045.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded: the recommendation this investigation was meant to produce already exists on record (doc 18 decision 8); live ownership sits with TASK-004/TASK-045.
<!-- SECTION:FINAL_SUMMARY:END -->
