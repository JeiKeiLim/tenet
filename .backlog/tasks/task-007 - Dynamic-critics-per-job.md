---
id: TASK-007
title: Dynamic critics per job
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-07-14 04:33'
labels: []
dependencies: []
priority: medium
ordinal: 7000
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When planning jobs, tenet agent creates critics tailored to each job. Add critic descriptions and let orchestrator choose critics after each job.

Extended thinking:
- Critics should be assigned per job, not globally. Some critics are relevant only for certain job types.
- The decomposition DAG could specify which critics apply to each job.
- Challenge: agents may create ad-hoc jobs for the same logical work — what happens to critic assignment then?
  - Option A: job itself declares its required critics
  - Option B: decomposition assigns critics, ad-hoc jobs inherit from parent
  - Option C: critics are selected dynamically based on job type/scope at dispatch time
- Related to TASK-002 (custom critics scoped within run) and TASK-036 (critic tiers — must/moderate/advisory).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Planning phase generates job-specific critic descriptions
- [ ] #2 Orchestrator can select appropriate critics after each job
- [ ] #3 Critic quality consistency is maintained
- [ ] #4 Critics can be assigned per job, not just globally
- [ ] #5 Decomposition DAG or job definition specifies which critics apply
- [ ] #6 Ad-hoc jobs have a clear critic assignment strategy
- [ ] #7 Backward compatible — existing jobs without critic specs get default set
<!-- AC:END -->
