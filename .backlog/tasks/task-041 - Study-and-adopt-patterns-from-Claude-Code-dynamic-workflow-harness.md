---
id: TASK-041
title: Study and adopt patterns from Claude Code dynamic workflow harness
status: To Do
assignee: []
created_date: '2026-07-13 23:45'
updated_date: '2026-07-14 00:16'
labels:
  - research
  - architecture
  - orchestrator
dependencies: []
references:
  - >-
    https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
  - 'https://code.claude.com/docs/en/workflows'
ordinal: 41000
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Claude Code's dynamic workflows let it write a custom JavaScript harness on the fly — spawning subagents, fanning out work, adversarially verifying results, and synthesizing output. Tenet should study and adopt relevant patterns.

Key insight: The dynamic workflow is just a JavaScript file with simple primitives — agent() and pipeline() — that Claude writes on the fly. This code structure IS what makes dynamic workflow possible. It's not a complex framework; it's a thin runtime that executes a generated script.

Example structure from Claude Code docs:
```
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}

const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)

return audits.filter(Boolean)
```

Key patterns from the article + docs:
- Fan-out-and-synthesize: split work into parallel agents, merge results
- Adversarial verification: each spawned agent gets a separate verifier agent
- Tournament: N agents compete on same task, judge picks winner
- Loop-until-done: keep spawning agents until stop condition met (no new findings, no more errors)
- Classify-and-act: classifier routes to different agent behavior
- Generate-and-filter: generate ideas, filter by rubric
- Workflows are JS scripts with agent() and pipeline() primitives — resumable, saveable, shareable
- Subagents run in isolated worktrees, can use different models
- Runtime caps: 16 concurrent agents, 1000 total per run
- Progress view shows per-agent token usage, status, results
- /deep-research is a bundled workflow example (fan-out search, cross-check, synthesize)

What Tenet can adopt:
- Dynamic harness generation (Tenet currently uses static decomposition DAG)
- Adversarial verification as a first-class pattern (not just post-hoc critics)
- Fan-out for parallel exploration (e.g., multiple hypotheses for root-cause)
- Tournament pattern for qualitative ranking/sorting
- Loop-until-done for flaky test detection, bug sweeps
- Per-agent model routing (cheap model for simple tasks, expensive for complex)
- Resumable runs with cached intermediate results
- The agent()/pipeline() primitive pattern — a thin runtime executing a generated script, not a heavy framework

Related articles:
- https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- https://code.claude.com/docs/en/workflows
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Document the key patterns from Claude Code dynamic workflows
- [ ] #2 Identify which patterns apply to Tenet's architecture
- [ ] #3 Propose concrete adoption plan for at least 2 patterns
<!-- AC:END -->
