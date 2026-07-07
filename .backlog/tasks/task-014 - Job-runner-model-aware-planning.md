---
id: TASK-014
title: Job runner model-aware planning
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
labels: []
dependencies: []
priority: high
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make tenet loop aware of which model is running and adapt planning accordingly. Local models may need finer-grained DAG splitting. Consider 3-tier model (Local/Standard/Frontier) and smart model selection per task type. v26.7.0 shipped partial prompt-only model_tier.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Planning phase adapts decomposition granularity based on model tier
- [ ] #2 Model tier is configurable (Local/Standard/Frontier or similar)
- [ ] #3 Subprocess model args are wired from the tier selection
- [ ] #4 Orchestrator can smart-select model per task type
<!-- AC:END -->
