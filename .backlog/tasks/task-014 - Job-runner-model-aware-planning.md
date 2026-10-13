---
id: TASK-014
title: Job runner model-aware planning
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 00:42'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Prompt-side progress (commit b477571): model_tier is now asked in all three modes (Full/Standard/Quick), recorded in ## Model Tier Decision, and gated by anti-skip (01-interview.md §9). Previously Full-only. Decomposition (04-decomposition.md §1) already consumes model_tier to shape DAG granularity — frontier = goal-oriented DAG, local = finer-grained. AC #1 (planning adapts) is satisfied at the prompt layer. AC #2/#3/#4 (configurable tiers, subprocess arg wiring, smart-select per task type) still need code work.

CLOSED 2026-10-13 (backlog cleanup audit, adversarially verified) as superseded: AC#1 (model tier surfaced to planning) shipped prompt-only - the model_tier standalone checkpoint in skills/tenet/phases/01-interview.md:32-34 (commits 65e1004/b477571, zero src/ files touched). ACs #2-#4 (tier-driven model wiring) were deliberately retired by docs/planning/18_model_tier_and_worker_context.md decisions 3-6 under the do-not-re-litigate-without-new-evidence rule. If tier-driven model wiring is ever wanted, file a fresh evidence-gated task; the critic-side tier work remains open in TASK-045.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded: the prompt-level model_tier checkpoint shipped; tier-driven model wiring was deliberately retired by the doc-18 decisions.
<!-- SECTION:FINAL_SUMMARY:END -->
