---
id: TASK-042
title: >-
  Add version mismatch detection on boot — warn when tenet binary version
  differs from project skill docs
status: To Do
assignee: []
created_date: '2026-07-14 01:05'
updated_date: '2026-07-14 04:34'
labels:
  - boot
  - reliability
  - ux
dependencies: []
ordinal: 42000
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When a user updates the tenet npm package (e.g. v26.7.3) but the project hasn't run 'tenet init --upgrade' (still on v26.7.1), the MCP tools load the new binary while skill documents/AGENTS.md/CLAUDE.md reference the old version. This mismatch can break tenet behavior in subtle ways.

Scenario:
- tenet npm updated to v26.7.3 → binary is v26.7.3
- Project .tenet/ skill docs still at v26.7.1 (no 'tenet init --upgrade' run)
- Coding agent loads v26.7.3 MCP tools but follows v26.7.1 skill instructions
- Mismatch may cause tool call failures, missing features, or behavioral drift

Fix: On boot sequence (when tenet init runs or when the orchestrator starts), compare the binary version against the version recorded in project docs. If mismatch, warn the user and suggest running 'tenet init --upgrade'.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Boot sequence compares tenet binary version against project doc version
- [ ] #2 Warning message is shown when versions mismatch
- [ ] #3 Suggests running 'tenet init --upgrade' to sync
- [ ] #4 Does not block execution — warning only
<!-- AC:END -->
