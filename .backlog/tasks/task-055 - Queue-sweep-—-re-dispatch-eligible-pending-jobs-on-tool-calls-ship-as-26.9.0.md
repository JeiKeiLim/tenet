---
id: TASK-055
title: 'Queue sweep — re-dispatch eligible pending jobs on tool calls, ship as 26.9.0'
status: To Do
assignee: []
created_date: '2026-09-02 22:24'
updated_date: '2026-10-13 00:42'
labels:
  - reliability
  - core
dependencies: []
references:
  - 2026_0901_retry_reset_no_dispatch_stall.md
  - 2026_0731_tenet_bug_from_podany.md
priority: high
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Problem** — Tenet dispatches a pending job from only 3 code sites (verified 2026-09-03, branch == origin/main): retry run-now (job-manager.ts:347, PR #22), child-spawn on parent success (job-manager.ts:1273), and the dispatchJob definition itself (job-manager.ts:118). Any pending job created outside those paths strands silently — the recurring wedge shape: a condition cleared, nothing re-dispatched the job.

Incident evidence:
1. 2026-09-01 podany report: retried job sat 4h31m undispatched. Root cause there was a stale global npm install from 2026-08-07 — PR #22 merged but never shipped (newest npm publish is 26.8.0, 2026-08-07). Releasing current HEAD resolves that incident class.
2. 2026-08-26 orphan incident (bb-wake-sleep-cycle): server died 4s into a job; the 30-min orphan reset marked it pending and nothing re-dispatched it. Reproduces at current HEAD — resetOrphanedJobs (job-manager.ts:109, :385 → state-store.ts:1416) resets to pending with no dispatch.
3. 2026-07-31 Bug 3: same class, eval flavor.

**Suggestion (recommended package, ~1-2 days):**
1. **Queue sweep** — a self-contained module that runs before answering hot-path MCP tool calls (tenet_job_wait, tenet_get_status, tenet_continue, tenet_start_job) and dispatches pending jobs that existing state already marks eligible: (a) auto_dispatch_on_parent_complete chains whose parent completed; (b) jobs left pending by orphan reset (after the heartbeat-timeout bar). Claim via the existing atomic mark-running WHERE status=pending pattern so concurrent sweeps cannot double-dispatch. No daemon, no DB migration, no new config. Eligibility can build on getNextRunnableJob() in state-store.ts, which already computes it — this task is the minimal event-driven first slice of TASK-050 (queue-servicer) and absorbs the re-dispatch half of TASK-054 (orphan recovery).
   - Deliberate boundary: only already-eligible jobs are picked up. Ordinary DAG dev jobs and failed-parent chains remain orchestrator decisions (TASK-037 audit warns against a blanket poller).
   - Parked, deliberately out of this task: blocked_on_finding auto-resume (07-31 Bug 1), failed-parent chain continuation, TASK-054 server_registry / verified ownership (the existing 30-min bar + sweep already closes the wedge; the registry stays a later enhancement), pending-staleness surfacing (superseded by the sweep).
2. **Ship as 26.9.0** (September → CalVer month reset; not 26.8.1): make check → make bump-month → tag v26.9.0 with user-facing notes → draft GitHub release → user clicks Publish → npm. Note: PR #22 has never reached npm — this release delivers it.
3. **Reinstall + verify** the global CLI on the dev machine per the 09-01 report section 9: confirm the retry-dispatch line and the sweep hook exist in the installed dist.

**Why this is not one more band-aid:** past fixes wired one-shot event triggers (the parent-finish moment, the retry moment) that go dead when the moment is missed. The sweep checks state instead of reacting to events — asked on every hot tool call, a missed moment self-heals. It is also the first slice of the TASK-050 servicer, so nothing is throwaway if the deeper restructuring happens later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Orphan wedge closed: integration test where a server dies mid-run — after heartbeat timeout the job resets to pending, and the next tool call from a living server dispatches it with no orchestrator action
- [ ] #2 Chain advance without double-dispatch: parent completes with an auto_dispatch child pending — child dispatched exactly once even when the child-spawn path and a concurrent sweep both fire
- [ ] #3 No blanket dispatch (negative tests): sweep does not start ordinary pending DAG jobs, does not continue a chain past a failed parent, and respects the configured concurrency limit
- [ ] #4 make check green including the new tests
- [ ] #5 Released as v26.9.0 through the standard flow; global CLI reinstalled on the dev machine; verification greps pass on the installed dist (retry-dispatch line + sweep hook present)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RE-TARGET (2026-10-13 cleanup audit): the release criterion is DONE - 26.9.0 shipped PR #22 to npm (verified published; the stale-global-install incident class is closed). The engineering criteria (#1-#4: sweep module, MCP hot-path hook, negative tests, make check green) remain open, now targeting 26.9.1+. Keep High only with a post-26.9.0 wedge recurrence; otherwise consider Medium.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 New self-contained module with unit + integration tests; hook wired at the MCP tool layer; sweep respects concurrency config
- [ ] #2 CLAUDE.md / README updated only where behavior is user-visible (sweep semantics, version)
- [ ] #3 26.9.0 release notes written user-facing; draft GitHub release created; user clicks Publish
- [ ] #4 TASK-050 and TASK-054 updated with a pointer to this task (or closed) after merge
<!-- DOD:END -->
