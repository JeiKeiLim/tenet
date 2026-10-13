---
id: TASK-005
title: Kanban feature
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-10-13 21:49'
labels: []
dependencies: []
priority: medium
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Offer project-level kanban board or tracking system within tenet, since the workflow naturally writes notes about what to fix next or improvement ideas.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Users can view and manage a kanban board for project tasks within tenet
- [ ] #2 Board integrates with the existing note-taking workflow
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLOSED 2026-10-13 (user decision, backlog cleanup): wont-do. The underlying need - tracking the fix-next notes and improvement ideas runs naturally produce - is already served by two shipped mechanisms (run-end drift notes consolidate into .tenet/runs/<run>/doctrine-proposals.md; durable improvement ideas go through tenet_update_knowledge to .tenet/knowledge/), and project-level task tracking is owned by the host-side tracker the maintainer actually uses (Backlog.md), consistent with Tenet's positioning as an agent harness that leans on host-agent capabilities. A tenet-internal board would duplicate that at the cost of new MCP tools + CLI surface + state to maintain. Reopen only if a real gap shows up: run outputs needing tracking that neither doctrine-proposals, knowledge, nor the host tracker captures.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed as wont-do: need covered by shipped homes (doctrine-proposals, knowledge) and host-side task tracking; harness philosophy says don't rebuild it.
<!-- SECTION:FINAL_SUMMARY:END -->
