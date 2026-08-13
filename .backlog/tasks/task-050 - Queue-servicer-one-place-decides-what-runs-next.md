---
id: TASK-050
title: 'Queue-servicer: one place decides what runs next'
status: To Do
assignee: []
created_date: '2026-08-12 22:30'
labels:
  - architecture
  - design
dependencies: []
priority: medium
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Concept (deferred from TASK-049 discussion, 2026-08-13): Tenet has NO background dispatcher. A job only starts via (1) immediate startJob, (2) explicit tenet_start_job({job_id}), or (3) dispatchChainedChildren on parent completion. Every resume condition must be hand-wired individually, and they keep getting missed — TASK-049 (retry_reset wedge: retry left a job pending forever) and the blocked_on_finding auto-resume bug (podany 0731 report) are the same shape: 'some condition cleared, nothing resumed the job.'

A queue-servicer collapses all of them into one rule: whenever job state changes, find every pending job whose dependencies are met and dispatch it (respecting maxParallelAgents). getNextRunnableJob() in src/core/state-store.ts already computes eligibility — today continue() only REPORTS its answer to the orchestrator; a servicer would ACT on it.

KEY DESIGN QUESTION to resolve before building: which jobs are allowed to advance themselves vs require the orchestrator's explicit blessing? The eval chain already self-advances (auto_dispatch_on_parent_complete); the core DAG flow does not (orchestrator gates each step with judgment). A blind poller would blast through the whole DAG with zero judgment between jobs — that property is deliberate. Candidate shape: event-driven servicer (dispatch only when a dependency completes) rather than a poller.

Related: concurrency limiting (dispatchJob/startJob do not check maxParallelAgents today); continue()/job_wait should still surface actionable state.
<!-- SECTION:DESCRIPTION:END -->
