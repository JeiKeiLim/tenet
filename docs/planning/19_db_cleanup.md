# 19 — Tenet DB Cleanup

**Created**: 2026-07-18
**Status**: Implemented (TASK-038)
**Origin**: Design discussion 2026-07-18 (TASK-038), grounded by a read-only forensic audit of a live **1.32 GiB** project `tenet.db`. Supersedes the ad-hoc discussion; this file is the single source of truth for the cleanup approach.

---

## TL;DR

`tenet db cleanup` — an **interactive, user-driven** command that reclaims SQLite bloat. Keyed on **age + status** (engine-set, reliable), **never run-keyed**. Deletes rows then **VACUUMs** (VACUUM-alone is a no-op on real data). **Non-terminal jobs are immortal** — cleanup cannot touch active/resumable work. Archives **job records** (not events) before delete. No background reaper, **no silent default cutoff** — the user picks a cutoff with the reclaim shown. **Concurrency-safe — no live-detection:** cleanup runs while the agent's server is open (SQLite WAL lets a separate cleanup process delete + VACUUM concurrently; verified 2026-07-18 on a faithful two-process probe); the status gate is the only correctness net.

| Lever | Decision |
|---|---|
| Trigger | Manual command only — nothing auto-deletes |
| Key | Age + status (not `run_slug`) |
| Shrink mechanism | Delete + VACUUM (freelist is 0 on real DBs) |
| Safety gate | Non-terminal jobs never prunable, regardless of age |
| Archive | Job `params`/`output`/`error` only; events are noise |
| Headline option | "Trim logs only" — biggest chunk, lowest value, keeps all verdicts |

---

## Problem statement

The Tenet SQLite store (`.tenet/.state/tenet.db`) grows unboundedly. A live project running qwen workers reached **1.32 GiB**. There is no reclaim path today beyond `tenet db snapshot` (which copies the whole thing). TASK-038 asks for a cleanup command — but *what to prune* and *how to do it safely* needed both a design and real data before building.

---

## The key reframe — what the DB is actually for

The DB is **not** long-term memory. Verified facts (file:line):

1. **Run-to-run memory lives in the file layer, not the DB.** The schema is four tables — `jobs`, `events`, `steer_messages`, `config` — with **no knowledge table** (`state-store.ts:862`). `tenet_update_knowledge` writes to `.tenet/knowledge/` *files* (`tenet-update-knowledge.ts:80-81,118`); journals go to the run dir. Doctrine lives in `.tenet/project/**`. A new run consults files, not prior DB rows.
2. **The loop only reads non-terminal jobs** + the active run's evals (`getEvalsForSource`) + retry context. Every `getJob()` read is by a specific id from the active run — no tool scans terminal history to drive a new run.
3. **The only cross-run DB reads are non-load-bearing:** status display (capped at `QUEUE_CAP = 100`), `findLatestE2eStatus` (a soft last-known-status signal), and the `all_done` count.
4. **`all_done = completedCount === totalCount` is unscoped** (`getTotalCount` = `SELECT COUNT(*) FROM jobs`, all runs; `state-store.ts:597`). So a prior run's rows affect the current run's completion flag — but this is a **wart, not a feature** (a stale failed job from run N can block `all_done` in run N+1; see TASK-037). Pruning prior runs incidentally *fixes* this for each fresh run.

**Conclusion:** the DB's run-driving value is **within-run** + crash-recovery of the immediately-prior running state. Terminal history is archaeology — safe to reclaim once archived.

---

## Why not run-keyed

A run identifier (`run_slug`) is tracked only **indirectly** — spread into each job's `params` JSON at registration (`tenet-register-jobs.ts:109-110`), with no column and no index. Worse:

- **Forensic:** only **7%** of jobs on the real 1.32 GiB DB carry `run_slug`. A run-keyed UI would silently miss 93%.
- **Structural:** the orchestrator is unsandboxed, so it cannot be *forced* to set `run_slug` every time — same root failure mode as TASK-033/035/037 (weak model drops a prompt-level expectation). Critic/child jobs often lack it and inherit via an ancestry walk (`getRunPath`, `tenet-update-knowledge.ts:21-40`).

Reliable axes are **engine-set**, not agent-set: `status`, `created_at`/`completed_at`, and the dispatch links `parent_job_id` / `source_job_id`. Cleanup keys on those.

---

## Forensic findings — the real 1.32 GiB DB

Read-only audit (2026-07-18) of a live project DB. These numbers shape the design.

**File:** 1.32 GiB, `page_size=4096`, `page_count=346430`, **`freelist_count=0`** → the file is ~99% live row/blob data. **VACUUM-alone reclaims zero bytes.**

**Where the bytes are:**

| Table / column | Bytes | % of live |
|---|---|---|
| `events.data` (transition logs) | 746 MB | 53% |
| `jobs.output` (verdicts/results) | 622 MB | 44% |
| `jobs.params` (prompts) | 35 MB | 3% |
| `steer_messages` / `config` | negligible | <0.1% |

By job type (params+output): `critic_eval` 304 MB / 1,935 rows, `interaction_e2e` 152 MB / 1,113, `eval` 110 MB / 1,075, `dev` 82 MB / 504 (largest avg, 199 KB/job), `integration_test` 8 MB / 132.

**Prunable vs protected:** 4,687 terminal (98.5%) vs **76 non-terminal protected** (75 pending + 1 running). The protected set is tiny and cheap to gate by status.

**Two findings that flip the naive design:**

1. **VACUUM-alone is a no-op** (freelist 0). The command must be delete + VACUUM, and must *tell the user* there is no free shrink.
2. **The bloat is recent, not old.** ~98% of bytes are from the **last 30 days**; everything past 30 d is ~18 MB of rounding error (the DB is 80 days old). This **kills the "safe 30-day default"** — a 30-day retention frees ~1%. Only 7–15 d retention moves the needle:

   | Keep last | Frees | % of DB |
   |---|---|---|
   | 7 d | ~707 MB | ~50% |
   | 15 d | ~482 MB | ~34% |
   | 30 d | ~18 MB | ~1% |
   | 90 d | ~0 | 0% |

   → the menu shows per-cutoff reclaim (computed), so the user reads the shape directly — no hard-coded narrative.

**Other:** not retry-driven (avg `retry_count` 0.15, only 6.2% of jobs ever retried). **332 orphaned events** already exist (`events.job_id` is not a FK) — evidence a partial prune happened before; cleanup must cascade and sweep.

> 📌 **Audit setup:** the audited DB was a copy of a real project's `.tenet/.state/tenet.db` placed in the working directory for inspection. The expected live location is `.tenet/.state/tenet.db` (resolved via the project path, same as the rest of tenet) — no path anomaly.

---

## Design

### Command

`tenet db cleanup` — slots into the existing `tenet db` group (`check` / `backup` / `snapshot` / `restore-snapshot`). Interactive when a TTY is present; flag-driven otherwise (`--keep-days`, `--before <date>`, `--mode {all|events-only}`, `--dry-run`, `--yes`, `--no-archive`).

### Flow

1. **Scan** the in-use DB (read-only aggregates).
2. **Show the lay of the land** — total size; freelist-reclaimable-without-delete (sets expectation: "VACUUM alone reclaims nothing"); per-category bytes; **protected** (non-terminal) count; **orphan** event count (swept silently).
3. **Show per-cutoff reclaim** — computed per cutoff; the table *is* the guidance (no hard-coded narrative line, which would be false on a differently-shaped DB).
4. **Menu** — pick a cutoff / mode (see mockup below).
5. **Dry-run confirm** — exact counts + bytes to reclaim; yes/no (default).
6. **Archive** prunable job records → **delete** (terminal jobs + cascaded events + orphan sweep) → **VACUUM**.
7. **Report** before/after file size.

### Interface mockup (real numbers)

All figures are **computed at runtime** from the actual DB, so the output is correct for any shape (1 MB, 10 GB, day-old or year-old). Numbers below are from the 1.32 GiB audit.

```
$ tenet db cleanup

⚠  tenet db cleanup deletes old finished jobs and compacts the database.
    It is safe to run any time (in-progress jobs are never touched), but for a
    large DB prefer running it between autonomous runs, not during one.

tenet.db is 1.32 GiB — almost entirely real data, so there's no quick
"compact"; shrinking it means deleting old work. Two things you can count on:
  • In-progress work (76 jobs still running or queued) is never touched.
  • Finished jobs we remove are archived to .tenet/archive/ first, so your
    results and critic verdicts stay recoverable.

What's taking up the space:
  Activity logs — the step-by-step history of each job .... 746 MB  53%
  Results & reviews — job outputs and critic verdicts ...... 622 MB  44%
  Prompts sent to workers ..................................  35 MB   3%

What would you like to do?

  Remove old finished work   (finished = completed, failed, or cancelled)
    [1] keep the last 7 days    → removes 3,264 jobs, frees ~707 MB
    [2] keep the last 15 days   → removes 2,583 jobs, frees ~482 MB
    [3] keep the last 30 days   → removes 1,511 jobs, frees  ~18 MB
    [4] keep everything since a specific date…

  Trim logs only — keep all your results and finished jobs; just drop
  old activity logs (these are just history, not archived)
    [5] drop logs older than 7 days    → frees ~382 MB, all results kept
    [6] drop logs older than 15 days   → frees ~263 MB, all results kept

  Reset
    [7] remove ALL finished work → frees ~1.3 GB
        (in-progress kept; everything else archived)

  [8] dry-run — show exactly what would happen, change nothing
  [0] cancel
```

### The events-only lever

`events` is the single biggest table **and** the lowest-value data (transition logs vs. verdicts in `jobs.output`). "Drop old events, keep every job row and its output" reclaims ~382 MB at a 7 d cutoff while **preserving the entire analysis record**. This is the move when the user wants space but not to lose verdict data — and it directly feeds the run-transcript evidence TASK-037 said was missing.

---

## Decisions and rationale (do not re-litigate without new evidence)

1. **Cleanup is manual, never automatic.** No background reaper, no timer. "Forgot for a month" cannot cause loss — nothing deletes itself; the user runs the command deliberately.
2. **No silent default cutoff.** The menu forces a deliberate choice with reclaim shown. A 30 d default would be cosmetic and misleading on a DB shaped like the audited one.
3. **Status gate: non-terminal jobs are immortal.** Cleanup physically cannot touch `pending`/`running`/`blocked`/`blocked_on_finding`, regardless of age — enforced in the delete query (`WHERE status IN ('completed','failed','cancelled')`), not just hidden in the UI. This is the guarantee that a resumable in-flight run survives.
4. **Age-keyed, not run-keyed.** `run_slug` is unreliable on real data (7%) and the agent can't be forced to set it. Age + status are engine-set.
5. **Delete + VACUUM, not VACUUM-only.** freelist is 0 on real DBs; VACUUM-only would be a no-op sold as cleanup.
6. **Archive job records, not events.** `output` holds verdicts (analytically valuable + undo-worthy); `events` are transition logs (noise + 53% of bulk — archiving them would double the bulk into a file). Archive path `.tenet/archive/cleanup-<timestamp>.jsonl`, one record per pruned job with `params`/`output`/`error`/`type`/`status`/timestamps/retry_count plus its `parent_job_id`/`source_job_id`/`run_slug`-if-present — relationships embedded so grouping is deferred to analysis time, no run-keying needed at archive time.
7. **"Trim logs only" (events-only) is a first-class menu option.** Biggest single lever; uniquely preserves verdicts.
8. **Cascade + sweep.** Deleting a job deletes its events by `job_id`; existing orphan events are swept. (`events.job_id` is not a FK; 332 orphans already exist on the audited DB.)
9. **No live-detection — cleanup is concurrency-safe.** (Reversed 2026-07-18 after empirical testing; originally "refuse while live".) The stdio-MCP server is always live and writes no pid (`server.pid` only comes from `tenet serve`'s `startBackgroundServer`, `index.ts:194`), and `-wal`/`-shm` sidecars are an unreliable signal — present under light load, absent after an autocheckpoint on heavy writes, lingering after a crash. Verified instead on a faithful two-process WAL probe (better-sqlite3: a separate cleanup process + an open server-stand-in connection): `DELETE` + `VACUUM` shrinks the file with the connection open — idle *or* mid-transaction (20 MB → 7.5 MB, no `SQLITE_BUSY`). The status gate (#3) is the real guarantee; a `busy_timeout` on the cleanup connection absorbs momentary write contention. Running cleanup while the agent is open is supported.
10. **Operate on `.tenet/.state/tenet.db` via the existing path resolution** (project path → StateStore). No special path logic; the audit DB was a copy placed in the working dir for inspection.
11. **Output is generated, not templated.** Every figure shown is computed at runtime from the actual DB, so the message is correct for any DB shape (1 MB, 10 GB, day-old, year-old). No hard-coded narrative line — the reclaim table is the guidance. No-op options (a cutoff that frees ~0) are dropped from the menu rather than shown as zeros.
12. **Unconditional warning, no live-detection gate.** Every invocation prints a one-line heads-up that cleanup deletes data and compacts, and to prefer running it between autonomous runs. Unconditional (not triggered by a heuristic) — for stdio users the server is always live, so a conditional / "refuse while live" gate would either always fire or lean on an unreliable signal (see #9). The status gate (#3) is the real safety guarantee; the warning is plain user guidance.

---

## Gap review (seams, assumptions, deferred)

1. **Archive growth** → each cleanup writes an archive file; over many runs the archive dir accumulates. Acceptable for now (user-controlled frequency; each archive is only that pass's deleted jobs). Consider archive retention/rotation only if it becomes a nuisance.
2. **`all_done` cross-run coupling** (decision-3 wart) → pruning prior runs incidentally helps each fresh run's `all_done`. No separate fix needed here; noted as a benefit.
3. **WAL sidecar bloat** → none on the audited DB, but the command reports `-wal`/`-shm` sizes and may need a checkpoint before VACUUM reclaims on other DBs.
4. **Slim-in-DB mode** (keep job rows, null blobs) → superseded by events-only + archive. Not built now.
5. **First-class `run_slug` column + index** → deferred unless age-based proves insufficient on a future DB.
6. **Resume safety after a long absence** → covered by the status gate (mid-flight runs stay non-terminal → immortal) + file-layer context (finished runs resume from `.tenet/project` + `.tenet/runs`, not DB rows). The only residual edge is a `failed`-but-unretried job aged out; the grace window + dry-run + archive cover it.

---

## Non-goals

- Auto-reaping / scheduled cleanup.
- Run-keyed UI or a `run_slug` schema migration.
- Archiving events.
- Slim-in-DB (null-the-blobs) mode.
- Touching file-layer memory (`.tenet/project`, knowledge, journal).

---

## Acceptance criteria

| # | Criterion |
|---|---|
| AC1 | `tenet db cleanup` exists; interactive when TTY, flag-driven otherwise (`--keep-days`, `--before`, `--mode`, `--dry-run`, `--yes`, `--no-archive`) |
| AC2 | Non-terminal jobs are never deletable — enforced in the delete query, not just the UI |
| AC3 | Approach documented and agreed — **this doc** (TASK-038 AC#3 ✅) |
| AC4 | Preview computes total size, freelist-reclaimable (VACUUM-without-delete), per-category bytes, protected count, orphan count, and per-cutoff reclaim — and renders them in user-facing terms (activity logs / results / prompts), dropping any no-op cutoff |
| AC5 | Delete cascades job→events and sweeps orphan events |
| AC6 | Job `params`/`output`/`error` archived to `.tenet/archive/` before delete; events not archived |
| AC7 | VACUUM runs after delete; before/after file size reported |
| AC8 | Concurrency-safe: runs while the server is live — status gate protects in-flight work, `busy_timeout` absorbs write contention, `DELETE`+`VACUUM` verified to shrink the file under an open WAL connection (idle and mid-transaction). No live-detection, no `--force` |
| AC9 | Operates on the project's `.tenet/.state/tenet.db` via existing StateStore path resolution |
| AC10 | Tests cover status-gate safety, cascade, orphan sweep, archive shape, dry-run no-op, age-banding, and adaptive output (tiny / recent-bloat / old-bloat shapes) |

---

## Implementation plan (grounded 2026-07-18)

A read-only codebase mapping confirmed every mechanism below exists to reuse. File:line anchors are current as of this date.

### Components

**1. StateStore read methods — `src/core/state-store.ts`** (alongside `checkDatabase:241`, `getTotalCount:597`). The `db` handle is a private better-sqlite3 field (`:198`); PRAGMA helpers exist (`pragmaTextRows` / `simpleNumberPragma:158-182`); `checkDatabase` already returns `page_size` / `page_count` / `freelist_count` in `DbHealthReport` (`:78-93`). Add read-only:
- `getDbStats()` — file + WAL/SHM sizes (`fs.statSync`) + freelist/page stats (reuse `checkDatabase`'s numbers).
- `getCategoryBytes()` — `SUM(LENGTH(events.data))`, `SUM(LENGTH(jobs.output))`, `SUM(LENGTH(jobs.params))` → the Activity-logs / Results / Prompts rows.
- `getStatusCounts()` + `getOrphanEventCount()` (`events LEFT JOIN jobs WHERE jobs.id IS NULL`).
- `getCleanupReport(cutoffs[], mode)` — the reclaim curve. For each cutoff, estimate bytes = `Σ LENGTH(params)+LENGTH(output)+LENGTH(error)` over terminal jobs older than the cutoff **+** `Σ LENGTH(events.data)` over their child events **+** orphan bytes. This is a `~` estimate (excludes page overhead) but its **rank ordering is exact**, which is what lets the menu drop no-op cutoffs.

**2. StateStore prune method — `src/core/state-store.ts`** (using the `this.db.transaction()` wrapper at `:762-778`). One transactional step: archive write → `DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND completed_at < cutoff` → `DELETE FROM events WHERE job_id NOT IN (SELECT id FROM jobs)` (cascade + orphan sweep in one statement, since `events.job_id` is not a FK) → then **outside** the txn: `checkpoint(TRUNCATE)` (`:819-823`) → `db.exec('VACUUM')`. The `WHERE status IN (...)` clause **is** the immortal-work gate (AC2) — enforced in SQL, not the UI.

**3. CLI — `src/cli/db-cleanup.ts`** (new file) + registration in `index.ts:343-410`. Mirrors `runDbSnapshot` (`db.ts:119-156`): `runDbCleanup(projectPath, opts)`, `console.log` output, throws on error; action handler uses `resolveProjectPath` (`index.ts:35`) + standard try/catch (`index.ts:364-374`). Reuses `formatBytes` / `timestamp` (`db.ts:6-15`). Flags: `--keep-days` / `--before <date>` / `--mode {all|events-only}` / `--dry-run` / `--yes` / `--no-archive`. The interactive renderer generates the menu from the reclaim curve (drop no-ops) mirroring the `promptAgent` numbered-menu (`init.ts:342-375`) and `promptYesNo` (`init.ts:326-340`) — readline only, no new dependency. Archive → `path.join(projectPath, '.tenet', 'archive', 'cleanup-<ts>.jsonl')` via `fs.appendFileSync(rec+'\n')` (`.tenet/archive/` is already scaffolded by `init`, `init.ts:10-19`).

**4. Tests — `src/cli/db-cleanup.test.ts`** mirroring `db.test.ts` (temp dir via `mkdtempSync`, real StateStore, `afterEach` rm). Seed normal jobs via `createJob`; seed controlled-age / orphan rows via raw `prepare().run()` INSERT (`state-store.test.ts:161-175`). No adapter needed — pure CLI/StateStore.

### Build sequence (each layer lands tested before the next)

1. StateStore read methods + unit tests (preview numbers).
2. `getCleanupReport` reclaim curve + age-band tests.
3. Prune transaction (status-gate, cascade, orphan sweep, VACUUM) + tests — the safety-critical core.
4. Archive writer + archive-shape test.
5. Preview renderer (adaptive output across tiny / recent-bloat / old-bloat fixtures).
6. Interactive menu + flag/TTY modes + dry-run.
7. Wire `tenet db cleanup` into the `db` group.

### Implementation decisions

- **A. No live-detection (reverses design decision #9; supersedes the earlier pid-file plan).** Empirically verified 2026-07-18 on a faithful two-process WAL probe: `DELETE` + `VACUUM` shrinks the file with a live server connection open — idle and mid-transaction, no `SQLITE_BUSY`. So cleanup runs while the agent is open; the status gate (#3) is the only correctness net it needs. `-wal`/`-shm` presence was tested and rejected as a heuristic (present under light load, absent after autocheckpoint, lingering after a crash — unreliable both ways). For robustness only: set a `busy_timeout` (e.g. 30 s) on the cleanup connection and handle a `SQLITE_BUSY` from `VACUUM` as a retry-then-report path. No pid file, no sidecar check, no `--force`.
- **B. Reclaim estimate is a `~`.** Post-`VACUUM` shrink can't be known before deleting (page overhead / fragmentation). The `LENGTH()`-sum in `getCleanupReport` is exact in rank-order (no-op cutoffs drop correctly) but approximate in magnitude — the menu renders it as "→ frees ~N". Acceptable.
- **C. Separate `db-cleanup.ts`, not folded into `db.ts`.** House style is one `db.ts`, but cleanup (preview + menu + prune) is materially larger than the other db subcommands; a separate file keeps `db.ts` coherent.
- **D. VACUUM needs a post-VACUUM `checkpoint(TRUNCATE)` to shrink the main file immediately.** Verified during implementation: in WAL mode `VACUUM` writes the compacted db through the WAL, and for a small resulting db (under `wal_autocheckpoint`) it stays in the WAL — the main file only shrinks on connection close. So `pruneCleanup` runs `checkpoint(TRUNCATE)` both before and after `VACUUM`; without the post-VACUUM checkpoint, `bytesAfter` wouldn't reflect the reclaim and the `-wal` sidecar would linger. Confirmed on the 1.32 GiB validation DB: a `--keep-days 7` prune shrank it to 667 MiB and archived 3,253 job records; the 76 in-progress jobs survived untouched.

---

## References

- **Code:** `src/core/state-store.ts` (schema `initSchema:862`, `getTotalCount:597`, `getCompletedCount:592`, `appendEvent:491`), `src/core/job-manager.ts` (`continue:370`, `all_done` math), `src/mcp/tools/tenet-update-knowledge.ts:118` (knowledge→files), the `tenet db` snapshot path (VACUUM / restore-swap patterns).
- **Audit:** read-only characterization of a real 1.32 GiB project DB (a copy placed in the working dir for inspection, 2026-07-18) — numbers in *Forensic findings* above.
- **Tasks:** TASK-038 (this), TASK-037 (loop-reliability; the archive feeds its missing run-transcript evidence), TASK-033/035 (unsandboxed-agent failure mode shared with "can't force run_slug").
- **Prior art:** `docs/planning/18_model_tier_and_worker_context.md` (doc style; "decisions do not re-litigate without new evidence" pattern).
