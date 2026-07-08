---
id: TASK-032
title: 'Context filtering: what to send to worker from project document?'
status: To Do
assignee: []
created_date: '2026-07-07 21:57'
labels:
  - design
dependencies: []
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sending all context (spec, harness, all decomposition, etc.) to the worker feels wasteful. There may be truly good context to include, but there is also unnecessary context being sent that could distract the worker. This also creates a design decision: how do we pass partial context from the project document to the worker? Needs discussion.

### Investigation Findings

**Two separate context assembly paths exist:**

1. **Orchestrator context** (`tenet_compile_context` in `src/mcp/tools/tenet-compile-context.ts:126-291`) — inlines spec, decomposition, interview, scenarios, harness, and all 5 project doctrine docs. Lists knowledge/design/journal/research/visuals as filenames only. This is for the orchestrator agent only, NOT forwarded to workers.

2. **Worker context** (`buildWorkerContext` in `src/core/job-manager.ts:750-804`) — inlines spec, scenarios, decomposition, and harness in full for EVERY worker and EVERY grounded critic. References journal/research/visuals as paths only.

**Wasteful patterns identified:**

- Every dev worker gets the full spec, full decomposition, full scenarios, and full harness — even for tiny focused tasks (e.g., "fix login button color" gets the entire multi-page spec)
- Every grounded critic (code, test, custom) receives the same full documents — for a run with 10 jobs × 3 grounded critics = 30 copies of the full spec sent to subprocesses
- The decomposition (DAG) is inlined for every worker — a worker doing job-3 sees all jobs, not just its own slice
- No per-job context tailoring — `buildWorkerContext` is type-agnostic and identical for every run; it does not look at the job's `prompt`, `dag_id`, or `depends_on`
- No context size budget — no mechanism to measure, truncate, summarize, or limit context size

**Existing filtering is minimal:**
- `full_context` flag on critics (code/test default `true`, interaction_e2e default `false`)
- Bulky docs (journal/research/visuals) are path-referenced, not inlined
- Agent steer capping (default 50)
- No section-level filtering, no token budgeting, no per-job relevance scoring

**Key files:**
| File | Lines | Purpose |
|------|-------|---------|
| `src/core/job-manager.ts` | 675-804 | `toInvocation()` + `buildWorkerContext()` |
| `src/core/job-manager.ts` | 806-864 | `withDevPreamble()` — dev worker prompt |
| `src/mcp/tools/tenet-compile-context.ts` | 126-291 | Orchestrator context compilation |
| `src/mcp/tools/tenet-start-eval.ts` | 10-42 | Job scope builder for critics |
| `src/mcp/tools/tenet-start-eval.ts` | 284-344 | `buildCriticDispatch()` — critic prompt assembly |
| `src/core/critic-roster.ts` | 1-248 | Critic roster with `full_context` flags |
| `src/core/artifact-paths.ts` | 1-130 | Artifact path types and resolution |
| `src/adapters/base.ts` | 1-22 | `AgentInvocation` interface (context + prompt) |
| `src/core/job-manager-worker-context.test.ts` | 1-226 | Tests for worker context assembly |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Determine which parts of the project document are relevant to a specific worker task
- [ ] #2 Design a mechanism to pass partial/selected context from the project document to the worker
- [ ] #3 Establish criteria for context filtering (e.g., task scope, worker role, dependency graph)
- [ ] #4 Decide on approach: section-level filtering, token budgeting, per-job relevance scoring, or a combination
- [ ] #5 Consider backward compatibility — existing runs should not break
<!-- AC:END -->


