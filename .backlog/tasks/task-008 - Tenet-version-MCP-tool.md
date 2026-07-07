---
id: TASK-008
title: Tenet version MCP tool
status: To Do
assignee: []
created_date: '2026-07-07 02:16'
labels: []
dependencies: []
priority: medium
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce a tenet version MCP tool so the agent is aware of version mismatches when user upgrades tenet mid-session. Also add guardrail prompt preventing agent from restarting tenet MCP server via raw commands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 MCP tool reports current tenet version
- [ ] #2 Agent detects version mismatch and suggests user restart
- [ ] #3 Guardrail prompt prevents agent from running 'tenet serve' or killing MCP process
<!-- AC:END -->
