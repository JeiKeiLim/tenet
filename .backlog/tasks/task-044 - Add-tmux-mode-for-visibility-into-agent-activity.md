---
id: TASK-044
title: Add tmux mode for visibility into agent activity
status: To Do
assignee: []
created_date: '2026-07-14 02:19'
updated_date: '2026-07-14 04:34'
labels:
  - ux
  - observability
  - design
dependencies: []
ordinal: 44000
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Default: disabled. When enabled, dispatching worker/critic agents opens separate tmux panes/sessions so the user can see what each agent is doing in real time.

Design challenge: How to launch a coding agent non-interactively and have it exit cleanly after finishing? The agent needs to run headless (no stdio interactive loop), do its work, and terminate. If this isn't possible, tmux mode may need a different approach — e.g. streaming logs to a visible pane instead of running the full agent TUI.

Open questions:
- Can coding agents (opencode, claude code) run in non-interactive/headless mode?
- If not, maybe tmux mode shows live logs/stdio instead of full agent TUI?
- How does this interact with MCP tool-based job dispatch (stdio vs session-based)?
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Tmux mode is opt-in (default disabled)
- [ ] #2 When enabled, user can see agent activity in separate panes
- [ ] #3 Agent exits cleanly after job completion
- [ ] #4 Does not break existing non-tmux workflow
<!-- AC:END -->
