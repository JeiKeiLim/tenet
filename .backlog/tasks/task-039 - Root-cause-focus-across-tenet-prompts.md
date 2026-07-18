---
id: TASK-039
title: Root-cause focus across tenet prompts
status: To Do
assignee: []
created_date: '2026-07-11 11:11'
labels:
  - prompts
  - quality
  - architecture
dependencies: []
priority: high
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tenet currently tends to prioritize immediate band-aid fixes over root-cause or architectural correctness. This task adds guidance across interview, spec, decomposition, critics, and readiness validation prompts to bias the agent toward identifying and fixing root causes rather than applying surface-level patches.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Interview phase prompts include a 'Root Cause' question category to probe underlying causes before solutioning
- [ ] #2 Spec phase requires a 'Root Cause Analysis' section that documents the true source of the problem
- [ ] #3 Decomposition phase includes root-cause verification as a job dependency check
- [ ] #4 Readiness rubric (tenet-validate-readiness.ts) scores 'Root Cause Identification' as a readiness category
- [ ] #5 Clarity rubric (tenet-validate-clarity.ts) includes root-cause clarity as a scoring dimension
- [ ] #6 Evaluation phase critics check whether the implementation addresses root cause, not just symptoms
- [ ] #7 Existing tests pass after all changes
<!-- AC:END -->
