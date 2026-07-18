---
id: TASK-012
title: Job waiting loop delegating to sub-agent
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-07-08 23:28'
labels: []
dependencies: []
priority: low
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed qwen3.6 delegating job waiting loop to sub-agent, which is clever context management. Evaluate whether this pattern should be formalized, and whether indefinite wait (remove 120s timeout) makes sense.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Sub-agent delegation pattern is evaluated for formal support
- [x] #2 Indefinite wait vs timeout behavior is decided
- [x] #3 Pattern works across opencode, codex, and claude code
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Formalized in v26.7.3: the execution-loop skill now recommends delegating the wait->eval->gather span to a tracked host sub-agent (narrowed the sub-agent ban to untracked work; added a 'Tracked Sub-Agent Delegation' subsection). Wait behavior decided: kept bounded backoff (30->120s cap), not indefinite. Cross-CLI confirmed by user - host sub-agents can call tenet MCP tools on Claude Code, Codex, OpenCode.
<!-- SECTION:FINAL_SUMMARY:END -->
