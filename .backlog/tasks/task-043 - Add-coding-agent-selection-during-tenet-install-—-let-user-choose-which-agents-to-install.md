---
id: TASK-043
title: >-
  Add coding agent selection during tenet install — let user choose which agents
  to install
status: To Do
assignee: []
created_date: '2026-07-14 01:12'
updated_date: '2026-07-14 01:13'
labels:
  - install
  - ux
  - design
dependencies: []
ordinal: 43000
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Currently tenet installs all supported coding agent adapters (opencode, claude code, etc.). As more adapters get added (e.g. cursor via PR), installing unused agents becomes redundant.

Proposal:
- Fresh install: prompt user with a selection UI to pick which coding agents to install
- Re-run with --agents: re-open the selection UI to add/change agent support
- Re-run with --agents --upgrade: select agents AND upgrade project docs

Open questions (captured for later design):
- Should removing an agent be possible? That adds complexity.
- How does --agents interact with --upgrade?
- What about headless/CI installs where interactive selection isn't possible? (maybe --all flag)

Reference: community PR adding cursor adapter sparked this.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Fresh install shows interactive agent selection
- [ ] #2 --agents flag re-opens selection UI
- [ ] #3 Non-interactive mode (CI) installs all agents by default or respects a flag
- [ ] #4 Existing installs are not broken by this change
<!-- AC:END -->
