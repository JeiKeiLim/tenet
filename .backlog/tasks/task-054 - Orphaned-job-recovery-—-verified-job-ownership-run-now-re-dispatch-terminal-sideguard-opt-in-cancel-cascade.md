---
id: TASK-054
title: >-
  Orphaned-job recovery — verified job ownership, run-now re-dispatch, terminal
  sideguard, opt-in cancel cascade
status: To Do
assignee: []
created_date: '2026-08-31 22:32'
updated_date: '2026-08-31 22:32'
labels:
  - reliability
  - core
  - bug
dependencies: []
references:
  - .backlog/tasks/task-050 - Queue-servicer-one-place-decides-what-runs-next.md
  - >-
    .backlog/tasks/task-034 -
    Use-worker-heartbeat-signal-instead-of-relying-on-job_wait-timeout.md
priority: high
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Incident

2026-08-26, real project test with the current build. The head job of a 9-job sequential eval chain stayed status=running for 30 minutes with no worker process. The tenet serve that dispatched it had created exactly that one job and died about 4 seconds after dispatch — an MCP client session teardown kills its serve, and 5 concurrent serve processes were live on that one project, so a mid-job server death is a routine event, not an exotic one. The 8 chained sibling critics stayed frozen pending behind the head. When the orphan reset finally fired, it landed exactly at the 30-minute heartbeat bar: the job went pending — and stayed there indefinitely. Tenet has no background dispatcher (only immediate startJob, explicit tenet_start_job, and dispatchChainedChildren on parent completion), and the orchestrator was blocked inside tenet_job_wait on that specific job, so nothing ever re-dispatched it.

## Root cause

Ownership is recorded but not verifiable. jobs.server_id says who runs a job; nothing records a verifiable fact about that owner. Every lifecycle decision infers death from one number (heartbeat age) against one hardcoded bar (30 minutes):

- resetOrphanedJobs (src/core/state-store.ts:1416) resets foreign-server running jobs only after 30 minutes, resets them to pending, and never re-dispatches.
- dispatchChainedChildren (src/core/job-manager.ts:520) fires only on parent completion — a cancelled or orphan-reset head strands the whole chain.
- cancelJob (src/core/job-manager.ts:285) does not cascade; incident cleanup required hand-cancelling 9 jobs.
- Terminal writes (completed at src/core/job-manager.ts:509, failed at :525) are unconditional. A zombie owner can overwrite a re-dispatched run: on laptop wake all timers fire at once, a sweeper can beat the first post-wake heartbeat, reset and re-dispatch while the original owner is actually alive; its late completion then clobbers the rerun. Last write wins today.

Explicitly NOT caused by the retry = run-now change (PR #22, commit 0b2a2d2): the stuck job was never retried (retry_count=0, no job_retried event); that PR touched only the retry path. This is the server-death member of the same family as the TASK-049 retry wedge and the blocked_on_finding resume bug, all rooted in there being no background dispatcher (TASK-050).

Worker stall is a DIFFERENT, already-separate path: the 2s heartbeat is written by the owning server regardless of worker progress, so a hung worker never looks orphaned — the adapter 120-minute timeout fails it and the normal retry flow applies. Do not conflate the two in implementation.

## Design — one primitive: verifiable job ownership

1. Server registry (src/core/migrations.ts; db_schema_version bump; migration only via tenet init --upgrade, never normal startup): table server_registry(server_id PK, pid INT, hostname TEXT, last_seen INT). The JobManager writes its row on start; last_seen is refreshed inside the existing 2s per-job heartbeat write. No trusted state — liveness is always re-checked.
2. Verified orphan reset + run-now re-dispatch. For each foreign-server running job, verify the owner: process.kill(pid, 0) when hostname matches → ESRCH means verified dead. Verified dead → reset to pending AND dispatchJob() immediately; resetOrphanedJobs returns the reset ids. Hostname mismatch or missing registry row → cannot verify → existing behavior: 30-minute bar, reset to pending, NO auto re-dispatch. Pid alive → never reset. If two servers race to re-dispatch, the existing atomic markJobRunning claim from PR #22 guarantees exactly one winner.
3. Terminal-write sideguard — the PR #22 claim pattern mirrored to the end of a job cycle: completed and failed updates become conditional claims whose WHERE clause pins both the running status and the owning server_id. Zero rows changed means ownership was lost (someone re-claimed the job) → the stale owner discards its result and a discard event is recorded.
4. Cancel cascade opt-in: tenet_cancel_job gains cascade (boolean, default false keeps the existing single-job behavior exactly). With cascade, recursively cancel every still-pending auto_dispatch_on_parent_complete descendant; response lists the cascaded ids; running jobs and non-auto-dispatch DAG jobs are never touched.
5. Observability: tenet_get_status view=queue rows gain owner_state (verified_dead | alive | unknown) and stale_reason distinguishes verified owner death from raw heartbeat timeout, so agents can see which bucket a non-terminal job is in before acting.

## Deliberately out of scope

- TASK-050 queue-servicer itself — this is its ownership-verification foundation slice, not the servicer.
- Changing the 30-minute heartbeat bar default — kept as the conservative fallback for unverified owners.
- Worker-side heartbeats — tracked separately in TASK-034 (worker liveness, not owner-process liveness).
- PID files or process-table probes beyond the registry row (pid + hostname in the DB is enough; no new files, no ps parsing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A running job whose owning server pid no longer exists (same hostname) is reset and immediately re-dispatched to running by the next job_wait or tenet_continue call — no 30-minute wait and no orchestrator action
- [ ] #2 A running job whose owner pid is alive is never reset or re-dispatched, regardless of heartbeat age — a live owner is never stolen from, including the post-sleep-wake case
- [ ] #3 When the owner cannot be verified (hostname mismatch or missing registry row), behavior falls back to the existing 30-minute heartbeat bar and reset jobs still do NOT auto re-dispatch
- [ ] #4 A late completion or failure write from the previous owner after a re-dispatch changes nothing: the write is an atomic conditional claim on running status plus owning server_id; zero rows means discard, and a discard event is recorded
- [ ] #5 tenet_cancel_job default behavior is unchanged (single job). With cascade=true it recursively cancels every still-pending auto_dispatch_on_parent_complete descendant, lists the cascaded ids in the response, and never cancels a running job or a non-auto-dispatch DAG job
- [ ] #6 tenet_get_status view=queue rows expose owner_state (verified_dead | alive | unknown) and stale_reason distinguishes verified owner death from raw heartbeat timeout
- [ ] #7 The schema migration runs only through tenet init --upgrade: normal StateStore startup on a pre-migration DB still refuses with the upgrade instruction; migration tests cover the new server_registry table
- [ ] #8 Unit and integration coverage: verified-dead reset plus re-dispatch (old manager with a blocked FakeAdapter and a planted stale row), alive-owner no-op, zombie-discard sideguard, cascade on/off with a deep chain (cancelled head strands a fully pending chain; running child untouched), registry row written on start and refreshed by the heartbeat timer
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. migrations.ts: add server_registry table + db_schema_version bump; verify normal startup refusal and init --upgrade path unchanged.
2. JobManager: write registry row on start (server_id, pid, hostname, now); refresh last_seen inside the existing 2s heartbeat timer write.
3. resetOrphanedJobs returns the reset ids instead of a count; add verifyOwner(server_id): same hostname → kill(pid,0) → verified_dead | alive; hostname mismatch or missing row → unknown.
4. detectStalledJobs: alive/unknown keep the 30-min bar with no re-dispatch; verified_dead resets and calls dispatchJob() for each in the same sweep. Constructor resets as today, then dispatches reset ids via setTimeout(0) after construction. Only ids this sweeper reset are ever dispatched — never chained roster pendings or DAG pendings.
5. StateStore: claim-based terminal write (UPDATE ... WHERE status=running AND server_id=mine); job-manager completion/failure sites use it and discard on 0 rows with a discard event.
6. tenet-cancel-job tool: cascade flag; recursive walk over child jobs with auto_dispatch_on_parent_complete and pending status; response lists cascaded ids.
7. tenet-get-status: owner_state per queue row from the registry + verifyOwner.
8. Tests per acceptance criteria; update README/CLAUDE.md tool tables and skill docs.

Related: TASK-050 (queue-servicer — foundation slice), TASK-034 (worker heartbeat — distinct mechanism), TASK-049 (previous wedge, fixed by PR #22).
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 make check green
- [ ] #2 make test-migrations passes with the server_registry migration
- [ ] #3 README and CLAUDE.md tool tables updated for the cascade option and owner_state; one recovery note added to the execution-loop skill doc
<!-- DOD:END -->
