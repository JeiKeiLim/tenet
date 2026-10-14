---
id: TASK-045
title: >-
  Critic designer should adapt to executioner model tier — split critics for
  local models
status: To Do
assignee: []
created_date: '2026-07-14 04:15'
updated_date: '2026-10-13 00:40'
labels:
  - critics
  - local-models
  - design
dependencies: []
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The custom critic designer document should be aware of the executioner model tier. When the model is a local/smaller model, critics should be:
- Simpler roles (not diminished quality, but narrower scope)
- Split into more granular sub-critics rather than one big critic
- A local model handling a single focused check is more reliable than one big critic trying to do everything

This means the critic designer should produce different critic configurations depending on model capability:
- Frontier model: fewer, broader critics (can handle complex multi-faceted checks)
- Local model: more, narrower critics (each does one simple thing well)

**Backstory / why this matters:**
A local model orchestrator was getting frustrated by too many retries (expected in tenet loop). But the root cause was different: the local model often fails at tool calls. The naive fix would be to simplify critic prompts to make them pass more easily — but that's wrong. Simplifying the prompt for a local model means simplifying the *critic itself*, which defeats the purpose. The correct approach is to keep critic quality but split into smaller, focused checks that a local model can reliably execute. Each sub-critic does one thing well, so the model doesn't need to juggle multiple concerns in one tool call.

Related to TASK-007 (dynamic critics per job), TASK-036 (critic tiers), TASK-004 (critic model selection).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Critic designer document includes model tier awareness
- [ ] #2 Local model critics are split into smaller, focused checks
- [ ] #3 Frontier model critics can be broader and fewer
- [ ] #4 Quality of checking is maintained regardless of model tier
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ANNOTATIONS (2026-10-13 backlog cleanup audit): (1) INHERITED from TASK-001 (closed as superseded): the weak-model-critic prompt-vs-capability question; recorded stance: capability/structural, prompt-simplification rejected. (2) PARK GATE REWORDED: proceed when a real weak/local-model run shows critic failures (measure-first rule per parked TASK-037) - no longer gated behind TASK-001. (3) INHERITED from TASK-046 (closed): supporting research citation - arXiv:2510.08847 (What is Your Agent's GPA?).
<!-- SECTION:NOTES:END -->
