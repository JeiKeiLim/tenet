---
id: TASK-037
title: >-
  Loop-reliability redesign — design investigation & grounding audit (parked:
  measure first)
status: To Do
assignee: []
created_date: '2026-07-08 22:09'
updated_date: '2026-07-08 23:03'
labels:
  - design
  - orchestrator
  - critics
  - reliability
dependencies: []
priority: medium
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Status: design investigation — PARKED.** An independent 9-agent code-grounding audit rated the proposed redesign **SHAKY (not sound, not dead)**: the direction is half-right, the full proposed stack is premature, and several pillars rested on unverified or refuted premises. **Do not implement until the Open Questions are resolved.** This task supersedes the ad-hoc design discussion and is the single source of truth for it.

## Problem

Weak orchestrator models (e.g. qwen3.6 27b) break the Tenet loop two ways:

- **TASK-035** — skip critics (they are slow, or most already passed) and advance anyway.
- **TASK-033** — say "I'll wait for the job" then never call `tenet_job_wait`; the loop freezes.

Today the rules "wait for the job" and "don't skip critics" live ONLY in the skill prompt. Nothing in the server enforces them, so a weak model that ignores the prompt breaks the loop. (Related: TASK-034 liveness, TASK-036 critic tiers.)

## Design that was explored (consolidated shape)

Server-side **critic gate** (dev job can't advance until its critics pass) + **`eval_round`** id (latest critic round wins after retry) + **`tenet_report`** MCP tool (structured critic verdicts, replacing fragile JSON scavenging) + server-side **auto-dispatch** of critics on dev completion + heartbeat **watchdog** + **kill-switch** config flag.

## Audit verdict: SHAKY — direction half-right, oversold, full stack premature

"Move invariants server-side, enforce at the action layer" is a sound *principle* (worthwhile defense-in-depth) but was oversold as a *complete fix*. **Measure the real problem before building anything.**

## Verified — these HOLD (confirmed with file:line)

- `tenet_continue` is strictly READ-ONLY (`job-manager.ts:370-387`). It dispatches/starts nothing.
- The ONLY pending→running transitions are `dispatchJob` (`job-manager.ts:146`) and `startJob` (`job-manager.ts:203`). Both check only `status==='pending'` — no dependency check, no critic check. So a non-bypassable gate MUST live in BOTH. A gate in `dispatchJob` alone is insufficient.
- `checkBlockingFindingResume` (`job-manager.ts:989`) is the only existing engine-level critic gate, but it is wired ONLY to the report-only `blocked_on_finding` path and fires on SUCCESS only (no failure/stall branch).
- NO dev→critic dependency edge exists today (critics carry `source_job_id`/`eval_stage` but no `depends_on` to the dev job; dev jobs complete unconditionally). **The gate is NEW architecture, not wiring.**
- `eval_round`: no concept today. `resolveExpectedEvalStages` reads the OLDEST cohort's stamp (`job-manager.ts:978`). `retryJob` keeps the same id and never touches critic rows → stale failed critics wedge the gate. `params` is a JSON column, so adding `eval_round` needs **NO DB migration**.
- Heartbeat = 2s `setInterval` (`job-manager.ts:442`). `detectStalledJobs` runs ONLY lazily (4 call sites: 251/268/371/395) — **NO wall-clock watchdog exists.**
- `all_done = completedCount === totalCount` (`job-manager.ts:376`) and `getCompletedCount` counts only `completed` → once any job terminally fails, `all_done` can NEVER become true. `max_retries` defaults to -1 (unlimited).
- No push/notification mechanism exists (MCP is request/response).
- The skill MANDATES `tenet_continue` before `tenet_start_job` (SKILL.md Core Invariant #1). Bypassing `continue` is a skill violation, not a sanctioned pattern.

## Refuted / shaky — these were WRONG

- **"Unbreakable regardless of what the agent does" — FALSE.** The orchestrator is unsandboxed (Write/Edit + subagents; SKILL.md:191 is a request, not enforcement). A weak model can edit files directly or spawn a subagent and never touch the job machine. A server gate only blocks JOB-STATE advancement, not out-of-band work.
- **"Kill switch is server-side, zero prompt complexity" — FALSE (audit G4).** The skill mandates the orchestrator call `tenet_start_eval` (step 8). Server auto-dispatch makes that contradictory; gate-OFF + gate-ON-prompt = critics silently stop. Needs a prompt rewrite, or no kill switch.
- **`dispatchJob` is NOT the only chokepoint.** `startJob` is a second pending→running path, and naively gating it DEADLOCKS critic dispatch (critics route through `startJob`). The gate must be specific to the dev→critic edge, not a blanket block on all pending→running transitions.
- **Auto-dispatch deliverable check is NOT reliable.** The only server-side check (`checkDeliverables`, `job-manager.ts:912`) catches only zero-git-diff; cannot detect context-limit/error/empty output.
- **A watchdog does NOT fix TASK-033.** A server timer cannot make a host call a tool. 033 is a host-boundary problem.
- **Strict all-critics-must-pass is BRITTLE** without a finite retry budget + terminal escape (conflicts with `max_retries=-1` default and the `all_done`-never-true bug; reconcile with TASK-036 tiering).

## OPEN QUESTIONS — must be resolved before any implementation

1. **`tenet_report` feasibility (UNVERIFIED).** The adapter spawns subprocesses with `--allowedTools` containing NO `mcp__tenet__` entries (`job-manager.ts:698` sets `allowedTools=undefined` for dev/code/test critics → adapter default list; `interaction_e2e` gets a Playwright list — neither includes tenet). BUT `tenet init` separately writes `mcp__tenet__*` permissions to the project config (`.claude/settings.local.json`, `.codex/config.toml`, `opencode.json` — `init.ts:1168`). **Which one wins is CLI-external behavior (differs Claude/Codex/OpenCode) and was NEVER tested.** The audit's "workers can't call tenet tools" was half-checked (only the adapter flag, not the project config). Resolution: empirically run a real worker/critic subprocess and try to call a tenet tool.
2. **No failure data.** No qwen3.6 run logs/transcripts exist in the repo. The actual locus/rate of failure is unmeasured — we do not even know whether the weak model routes work through the job machine at all vs. working out-of-band (direct edits/subagents), in which case **no server-side gate has anything to act on.** This is the #1 thing to establish.

## Recommended next step (audit recommendation, agreed)

1. **Measure first** — collect real failure data from a qwen3.6 run (where does it break: `job_wait`? `start_eval`? all-must-pass? out-of-band?).
2. **Most defensible single piece** (if anything is built): server-side critic auto-dispatch + a REAL deliverable-quality check (commit-SHA presence, error-string detection, non-empty output). Targets the eval-skip half of TASK-035; clear correctness argument; only helps work that goes through the job machine.
3. **Watchdog = state-hygiene only**, NOT the TASK-033 fix. Attack 033 at the host boundary (louder `tenet_continue` signal / push-based loop / accept a skip rate).
4. **Do NOT build** the full gate / `eval_round` / kill-switch / `tenet_report` stack until the failure data is in and the open questions are closed.

## Key files

| File | Lines | Purpose |
|------|-------|---------|
| `src/core/job-manager.ts` | 146-179 | `dispatchJob` — action-layer gate site #1 |
| `src/core/job-manager.ts` | 203-248 | `startJob` — action-layer gate site #2 |
| `src/core/job-manager.ts` | 370-387 | `continue()` — read-only, NOT a gate site |
| `src/core/job-manager.ts` | 989-1067 | `checkBlockingFindingResume` (existing report-only gate) |
| `src/core/job-manager.ts` | 912-942 | `checkDeliverables` (only catches zero-git-diff) |
| `src/core/state-store.ts` | 529-590 | `getNextRunnableJob` / `dagDependenciesCompleted` (advisory only) |
| `src/core/state-store.ts` | 618-627 | `getEvalsForSource` (all siblings, ASC, unfiltered) |
| `src/adapters/claude-adapter.ts` | 13-22, 51 | `DEFAULT_ALLOWED_TOOLS` (no `mcp__tenet__`) |
| `src/cli/init.ts` | 1168 | writes `mcp__tenet__*` perms to project config |
| `skills/tenet/phases/05-execution-loop.md` | 17-52 | the 13-step per-cycle sequence |
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Empirical failure data collected from a real weak-orchestrator (qwen3.6) run: where the loop actually breaks (job_wait / start_eval / all-must-pass / out-of-band), with transcript or log evidence
- [ ] #2 tenet_report feasibility empirically verified: a real worker/critic subprocess is run and confirmed able (or unable) to call a tenet MCP tool, given the adapter --allowedTools flag vs the project-config permissions written by tenet init
- [ ] #3 Decision recorded on whether the weak orchestrator routes work through the job machine at all (if it works out-of-band via direct edits/subagents, no server-side gate helps — documented and approach adjusted)
- [ ] #4 If proceeding to build: gate placed at BOTH dispatchJob AND startJob (never at continue/getNextRunnableJob), specific to the dev→critic edge (not a blanket pending→running block), with a fail-branch + terminal escape + atomic evaluation
- [ ] #5 Strict must-pass reconciled with TASK-036 tiering and a finite retry budget / terminal escape (no infinite loop under the max_retries=-1 default)
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-07-08 23:03
---
2026-07-09 resolution: Open Question #1 (sub-agent feasibility) is CONFIRMED — user verified host sub-agents can call tenet MCP tools on all 3 CLIs (Claude Code, Codex, OpenCode). Chose the cheap prompt-only path over the full server-side stack: the 3 execution-loop subagent prohibitions were over-broad (they targeted the mechanism, not the harm — the stated rationale was "bypasses job tracking", and a sub-agent that routes through tenet tools bypasses nothing). Narrowed them to ban untracked work, and added a "Tracked Sub-Agent Delegation (recommended)" subsection to skills/tenet/phases/05-execution-loop.md plus a matching SKILL.md Execution Rule. The full server-side gate / eval_round / tenet_report / watchdog stack remains PARKED — only revisit if the delegation recommendation fails to hold. Acceptance test: run qwen3.6 with the new prompt and confirm the runs that previously did NOT delegate now do.
---
<!-- COMMENTS:END -->
