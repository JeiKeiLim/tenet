---
id: TASK-038
title: tenet db cleanup CLI command
status: To Do
assignee: []
created_date: '2026-07-09 03:59'
updated_date: '2026-07-18 13:38'
labels: []
dependencies: []
priority: high
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tenet SQLite DB grows unboundedly (observed ~500MB on a project with local models). Need a CLI command to clean up/compact the DB. Approach TBD — needs discussion on what to prune (old job results? full event history? snapshots?) and whether cleanup helps agent history tracking at all.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI command exists (e.g. tenet db cleanup or tenet db vacuum)
- [ ] #2 Command is safe to run on an active project
- [x] #3 Approach for what to prune is documented and agreed upon
- [ ] #4 DB size reduction is measurable after cleanup
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-18 13:34
---
2026-07-18: cleanup approach designed + agreed — documented in docs/planning/19_db_cleanup.md (grounds TASK-038 AC#3). Shape: 'tenet db cleanup', interactive + flag-driven. Manual only (no reaper), no silent default cutoff. Keyed on age + status (NOT run_slug — only 7% of jobs on the real 1.32 GiB DB carry it; agent can't be forced). Non-terminal jobs are immortal (status gate in the delete query). Delete + VACUUM (freelist=0 on the real DB → VACUUM-alone is a no-op). Archive job params/output/error (not events) before delete. First-class 'events-only' option — events are 53% of bulk + lowest value, keeps all verdicts. Cascade job→events + sweep orphans (332 already exist; events.job_id not a FK). Refuse while live. Resolve in-use DB path, don't hardcode .tenet/.state/ (audit found the 1.3 GiB DB at repo root — separate path bug to file). Forensic audit of the live DB drove two design flips: (1) VACUUM-alone reclaims nothing, (2) bloat is recent — 30d retention frees ~1%, only 7-15d moves the needle, so the menu must show per-cutoff reclaim. Detailed ACs + non-goals + sequence in the doc. Implementation ACs (#1/#2/#4) remain open.
---

created: 2026-07-18 13:38
---
Correction (same day): the 'audit found the DB at repo root / separate path bug to file' note in the prior comment was wrong — that tenet.db was a copy I placed in the working dir for inspection. The expected + only location is .tenet/.state/tenet.db (resolved via the project path / StateStore like the rest of tenet). Doc updated: decision #10, AC9, and the audit note revised; the false 'path anomaly' side-finding removed. No path-resolution bug to file.
---
<!-- COMMENTS:END -->
