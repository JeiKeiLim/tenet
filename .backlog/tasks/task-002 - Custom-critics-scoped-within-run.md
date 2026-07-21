---
id: TASK-002
title: Custom critics scoped within run
status: Done
assignee: []
created_date: '2026-07-07 02:16'
updated_date: '2026-07-21 22:21'
labels:
  - skill
dependencies: []
priority: medium
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On top of default critics + user custom critics, tenet should suggest run-specific critics based on what it learned during interview → spec phase. Evolve from general critics to job-aware tailored critics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Tenet generates run-specific critic suggestions from interview/spec context
- [x] #2 Run-specific critics are applied alongside default and user custom critics
- [x] #3 Related to #13 (weak model critics) and #24 (critic model selection)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Two-scope critic layout (no code change — prompt_file already resolves project-relative paths):
- Global (durable): .tenet/critics/*.md, hand-authored via critics.md.
- Run-scoped (ephemeral): .tenet/runs/<run-slug>/critics/*.md, generated per run, pruned or promoted at run end.

New loop step (Critic Tailoring) in phases/02-spec-and-harness.md after the readiness gate, before decomposition:
1. Read interview.md + spec.md + scenarios.md + existing .tenet/critics.json + global .tenet/critics/*.md.
2. Identify run-specific risk surfaces the 3 built-ins under-cover (concrete focus, not generic review).
3. For each gap: write .tenet/runs/<run-slug>/critics/<id>.md following the critics.md output contract; add a roster entry pointing at it. Reuse an existing global critic if one already covers the gap.
4. Quick mode skips tailoring; Standard/Full run it.

Run-end prune/promote in phases/05-execution-loop.md run-completion section:
- At all_done, for each run-scoped critic: drop by default; promote to global if it caught a real failure this run (move file to .tenet/critics/, rewrite roster entry).

Files: skills/tenet/critics.md (two-scope layout + tailoring workflow + prune/promote), skills/tenet/phases/02-spec-and-harness.md (new §7), skills/tenet/phases/05-execution-loop.md (run-end critic lifecycle), skills/tenet/SKILL.md (Phase Map pointer), AGENTS.md + CLAUDE.md (.tenet/ document layout note).

Deferred (linked follow-ups): TASK-007 per-job critics in DAG, TASK-036 must/moderate/advisory tiers, TASK-045 model-tier-aware critic splitting, TASK-004 critic model selection.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Workflow/skill only. No code change (prompt_file already resolves project-relative paths).

§4.5 structure (three steps):
- Step 0 — Orphan sweep: scan .tenet/critics.json for entries whose prompt_file is under .tenet/runs/<other-slug>/critics/ (not the current run). Drop as stale. Defensive — matches Tenet orphan-recovery pattern. Becomes a no-op once TASK-048 (run-local roster + merge) lands.
- Step 1 — Review global custom critics against this run's spec: keep / disable for this run (enabled:false, do not delete file) / flag stale scope as doctrine drift. Globals earn their place once but don't apply to every feature.
- Step 2 — Generate run-scoped critics for gaps the enabled globals don't cover.

Run-end lifecycle (§4.5 subsection): drop (default) / promote to global (if caught real failure AND repo-wide) / restore disabled globals (disable is per-run by default, must not silently persist).

Decision (2026-07-20): run-local roster file (.tenet/runs/<run-slug>/critics.json) deferred to new TASK-048. It is load-bearing for TASK-007 (per-job critics), TASK-036 (tiers), TASK-047 (hybrid dispatch), TASK-004/045/001 (model selection) — shared infrastructure, not a TASK-002 detail. TASK-002 ships with the file-path-scan orphan sweep; TASK-048 makes it structural.

Follow-ups: TASK-048 (run-local roster + merge), TASK-007 (per-job critics), TASK-036 (tiers), TASK-045 (model-tier-aware critic splitting), TASK-004 (critic model selection).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented run-scoped critics + Critic Tailoring step (commit 5ab0d5e). Two-scope layout: global .tenet/critics/*.md (durable, hand-authored via critics.md) + run-scoped .tenet/runs/<run-slug>/critics/*.md (ephemeral, generated per run). New §4.5 in phases/02-spec-and-harness.md runs after readiness gate: orphan sweep, global-critic review, run-scoped critic generation. Run-end lifecycle prunes/promotes at run completion. No code change — prompt_file already resolves project-relative paths (src/mcp/tools/tenet-start-eval.ts:325-331). Follow-up: TASK-048 (run-local roster + merge), TASK-045 (critic designer adapts to local model tier), TASK-014 (wire model_tier to subprocess args). Mode-selection timing fix (commit b477571) split boot-time Full/Standard/Quick from end-of-interview delivery_mode + model_tier, made model_tier asked in all three modes.
<!-- SECTION:FINAL_SUMMARY:END -->
