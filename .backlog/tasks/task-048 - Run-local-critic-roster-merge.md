---
id: TASK-048
title: Run-local critic roster + merge
status: To Do
assignee: []
created_date: '2026-07-20 22:28'
labels:
  - feature
  - critics
  - infrastructure
dependencies:
  - TASK-002
priority: medium
ordinal: 48000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce a run-local critic roster at .tenet/runs/<run-slug>/critics.json that tenet_start_eval merges with the global .tenet/critics.json per job. Shared infrastructure that unblocks the critic-config cluster.

Why separate from TASK-002: TASK-002 shipped workflow-only (orphan sweep via file-path scan in phases/02-spec-and-harness.md §4.5 Step 0). The run-local roster is a code change to critic-roster.ts + tenet-start-eval.ts and is load-bearing for several downstream tasks, so it gets its own task rather than being bundled into a workflow change.

Unblocks:
- TASK-007 (per-job critics): per-job assignment needs a per-run home, not a mutable global file.
- TASK-036 (must/moderate/advisory tiers): per-run tier overrides need a run-local home if tier varies by feature.
- TASK-047 (hybrid parallel/sequential dispatch): per-critic parallel_safe metadata needs a home if it varies by run.
- TASK-004/045/001 (model selection & model-tier-aware splitting): per-run model assignments keyed by model_tier.

Side effect: makes TASK-002's Step 0 orphan sweep structural (run-scoped state dies with the run dir, no orphans possible) — Step 0 becomes a no-op once this lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 critic-roster.ts loads .tenet/runs/<run-slug>/critics.json when present and merges with global roster (run-local entries win on id collision)
- [ ] #2 tenet_start_eval resolves the merged roster per job
- [ ] #3 Missing/invalid run-local roster falls back to global-only (no regression)
- [ ] #4 Backward compatible: existing .tenet/critics.json-only projects work unchanged
- [ ] #5 TASK-002 Step 0 orphan sweep becomes a no-op once run-scoped critics live in the run-local roster
<!-- AC:END -->
