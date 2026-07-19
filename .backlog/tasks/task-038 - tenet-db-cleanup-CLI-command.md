---
id: TASK-038
title: tenet db cleanup CLI command
status: In Progress
assignee: []
created_date: '2026-07-09 03:59'
updated_date: '2026-07-18 14:50'
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
- [x] #1 CLI command exists (e.g. tenet db cleanup or tenet db vacuum)
- [x] #2 Command is safe to run on an active project
- [x] #3 Approach for what to prune is documented and agreed upon
- [x] #4 DB size reduction is measurable after cleanup
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

created: 2026-07-18 14:11
---
Implementation plan grounded (2026-07-18): doc 19 now has an 'Implementation plan' section — 4 components with file:line anchors, an ordered 7-step build sequence, and implementation decisions A/B/C. A (live-detection, elaborates design decision #9): pid-file is the signal — tenet serve writes .tenet/.state/server.pid (index.ts:194 in startBackgroundServer:180); status.ts:107-112 reads it via readPid/isProcessAlive; --force mirrors restoreDatabase (state-store.ts:332-353). Gap noted: the host-agent stdio path doesn't write the pid, so pid-presence is sufficient-not-necessary and the status gate (non-terminal jobs immortal) is the real guarantee; SQLITE_BUSY from VACUUM handled as an explicit error path. B: reclaim is a LENGTH()-sum '~' estimate, exact in rank-order so no-op cutoffs drop correctly. C: new src/cli/db-cleanup.ts (separate from db.ts). Build starts at StateStore read methods.
---

created: 2026-07-18 14:21
---
Design reversal (2026-07-18): dropped 'refuse while live' (design decision #9 + impl decision A). Reason: the stdio-MCP server is always live and writes no pid (only 'tenet serve' writes server.pid, index.ts:194), and -wal/-shm sidecars are an unreliable live signal (present under light load, absent after autocheckpoint, lingering after crash). Empirical two-process WAL probe (better-sqlite3, faithful to tenet): DELETE + VACUUM shrank the file 20MB->7.5MB with an open server-stand-in connection -- idle AND mid-transaction, no SQLITE_BUSY. So cleanup runs while the agent is open; the status gate (non-terminal jobs immortal) is the only correctness net. Kept for robustness only: busy_timeout + graceful SQLITE_BUSY retry/report. No pid file, no sidecar check, no --force. Doc updated: TL;DR, decision #9, AC8, impl decision A, references.
---

created: 2026-07-18 14:50
---
Implemented on branch feat/db-cleanup (2026-07-18). tenet db cleanup shipped: StateStore.getCleanupPreview (read-only reclaim curve) + pruneCleanup (archive stream -> txn delete w/ status gate -> cascade -> orphan sweep -> checkpoint(TRUNCATE) -> VACUUM -> checkpoint(TRUNCATE)) in state-store.ts; src/cli/db-cleanup.ts (unconditional warning, adaptive render, no-op-dropping menu, interactive + flag-driven); wired into the db group in index.ts. Unconditional warning per design decision #12 (no live-detection). Gate: typecheck + lint + 267 tests pass (15 new in db-cleanup.test.ts covering status gate, cascade+orphan, archive shape, dry-run no-op, age-banding, VACUUM shrink, adaptive render/menu). Validated on a COPY of the real 1.32 GiB DB: --keep-days 7 removed 3,253 finished jobs + 23,854 events + 332 orphans, archived 3,253 records (346 MB), shrank tenet.db 1.32 GiB -> 667 MiB; all 76 in-progress jobs survived. Implementation note (design decision D): VACUUM writes through the WAL, so a post-VACUUM checkpoint(TRUNCATE) is required for the main file to shrink immediately.
---
<!-- COMMENTS:END -->
