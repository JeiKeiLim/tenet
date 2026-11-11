---
id: TASK-058
title: >-
  Adviser-model escalation — route blocking questions to a strong adviser model
  before the user
status: To Do
assignee: []
created_date: '2026-11-11 22:07'
updated_date: '2026-11-11 22:12'
labels:
  - feature
dependencies: []
ordinal: 58000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: when a worker hits a real decision point (spec ambiguity, contradiction between frozen tests, needs a change the harness forbids), the orchestrator stops and asks the user — blocking the autonomous loop. If the user is not at the CLI, the loop sits idle for hours. Motivating case (2026-10-12, agent-generator ACT GENERATED run): the J04 worker was blocked on a version-selection ambiguity; its own recommended option was wrong (it had missed frozen tests A2/A7 in test_act_registration.py); a strong-model adviser with full repo access found the correct fourth option that neither the worker's picker nor the spec contained. Full manual-workflow writeup: Obsidian note 2026-10-13-tenet-adviser-model-escalation.md in the user's MyObsidian vault, 03_Hermes/03_Projects/02_Tenet/ (context only — where note and task differ, this task wins; see implementation notes).

DESIGN (user-confirmed 2026-11-12 interview):
(1) Config — two new slots: adviser_agent (valid values: claude-code, opencode, codex — adapter registry keys, NOT 'claude') and adviser_model, set via tenet config --adviser-agent / --adviser-model. Unset = exactly current behavior (the question goes to the user). Adviser config is read from config.json at MCP server startup, NOT via the StateStore loadFileConfig whitelist — see implementation notes for the silent-no-op trap.
(2) Dispatch — new MCP tool 'tenet_ask_adviser' dispatches a new 'adviser' JobType through the existing adapter dispatch machinery with the adviser params; effectively 'claude --model <model> -p <escalation question>' via invocation extraArgs. Run-now dispatch, waitable through the existing tenet_job_wait / tenet_job_result loop — no new wait machinery.
(3) Trigger — orchestrator judgment only; Tenet detects nothing and parses nothing. New skill step in phases/05-execution-loop.md: at any moment the orchestrator would otherwise halt and ask the user, it composes the escalation question from the worker's report (verbatim when the worker surfaced options, as in the motivating case; otherwise synthesized from failure/repetition evidence — the dev preamble stays unchanged, workers never get a formal question channel) and dispatches the adviser.
(4) Adviser contract — read-only enforced at prompt level only (frontier-capability model makes prompt-level sufficient); bespoke adviser preamble (do NOT reuse report_only — wrong semantics, see implementation notes); input: the composed question + explicit path pointers to run artifacts (spec, scenarios, frozen test paths) — the adviser does NOT get the standard inlined worker run-context block; its edge is full-repo access, not the worker's narrowed compiled context; guardrail: the adviser must verify worker-cited claims against the repo rather than trusting the question's framing (the motivating case shows the worker's option list itself can be the bug); it may instead return 'genuinely user\'s call' with a distilled decision frame, which then goes to the user.
(5) Answer flow — the adviser's output returns to the orchestrator like any worker report (job result); the loop continues with no human gate; the orchestrator decides what to do with the recommendation (retry with enhanced prompt, steer, blocking finding, or ask the user).
(6) No invocation cap — it fires only at real decision points.
(7) Journal every escalation (question, adviser evidence, decision taken) via tenet_update_knowledge(type='journal') so retrospectives can measure how often the adviser overturns the worker's own recommendation.
(8) When no adviser is configured, tenet_ask_adviser returns a structured adviser_configured:false payload with 'ask the user' guidance, not an error.

Distinctions: TASK-006 (PM agent) is proactive periodic oversight — this task is reactive, question-scoped escalation; TASK-004's frontier-review-gate fragment is eval-time and stays there.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 tenet config accepts --adviser-agent and --adviser-model; when unset, all behavior is unchanged (orchestrator asks the user, exactly as today)
- [ ] #2 The adviser job prompt enforces read-only-by-instruction and requires either a grounded recommendation with evidence (file:line citations) or a 'genuinely user's call' distilled decision frame
- [ ] #3 The skill execution loop (phases/05-execution-loop.md) documents the escalation step: before stopping to ask the user, the orchestrator dispatches the adviser when one is configured and feeds the answer back into the loop; each escalation is journaled (question, adviser evidence, decision taken)
- [ ] #4 Unit tests with the non-spawning test doubles (MockAdapter/FakeAdapter) cover configured dispatch, unset-config no-op, and the answer-return path
- [ ] #5 New MCP tool tenet_ask_adviser dispatches an adviser job through the configured adapter with the adviser model and the escalation question; the name is added to TENET_MCP_TOOL_NAMES (auto-updates .claude/settings.local.json and .codex/config.toml) AND to skills/tenet/SKILL.md frontmatter allowed-tools (manually enumerated; the drift test does not cover it); CLAUDE.md and README.md tool counts update from 19 to 20
- [ ] #6 'adviser' is added to all three JobType enumeration surfaces: the Job type union (src/types/index.ts), the jobTypeSchema Zod enum (src/mcp/tools/utils.ts — also fix its pre-existing drift: it omits integration_test), and the JOB_TYPES array driving *_args_<jobtype> lookup (src/adapters/index.ts); adviser_job is not marked 'dev' — checkDeliverables would fail a text-only recommendation
- [ ] #7 adviser_agent and adviser_model reach the MCP tool via the server-startup config.json read (adapter-args precedent, src/mcp/index.ts loadAdapterExtraArgs), not the StateStore loadFileConfig whitelist; a test covers the configured path end-to-end: config keys -> tool -> dispatched adviser job with ['--model', <adviser_model>] in invocation extraArgs
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
STANDALONE AUDIT (2026-11-12, fresh-context agent; all citations verified against code at HEAD 26.10.2):

TOOL SURFACE
- Registration: one file per tool — src/mcp/tools/tenet-ask-adviser.ts exporting registerTenetAskAdviserTool; the drift test derives the snake-case name from safeRegister(() => registerTenet<X>Tool( and asserts TENET_MCP_TOOL_NAMES parity (src/mcp/tools/tool-names.test.ts) — but it does NOT check skills/tenet/SKILL.md allowed-tools, which enumerates every tenet tool by hand (~frontmatter lines 11-31); add the tool there too or projects that have not re-run tenet init --upgrade hit a permission prompt mid-skill.
- Doc-count drift: CLAUDE.md ('Exposes 19 tools') and README.md ('19 tools') go stale with a 20th tool.

JOB TYPE — why not reuse 'dev'
- executeJob runs checkDeliverables on job.type === 'dev' (src/core/job-manager.ts:570-571); a text-only recommendation fails it: 'Dev job completed but produced no file changes' (:990-994). Hence a dedicated 'adviser' JobType.
- Three enumeration surfaces, two fail silently: Job type union (src/types/index.ts:10); Zod enum jobTypeSchema (src/mcp/tools/utils.ts:19 — pre-existing drift, omits integration_test, fix alongside); hard-coded JOB_TYPES array driving *_args_<jobtype> config lookup (src/adapters/index.ts:18-27 — missing member silently disables the args key, no type error).
- No DB migration: jobs.type is unconstrained TEXT (src/core/state-store.ts:1248-1259).

CONFIG PLUMBING — the silent no-op trap
- loadFileConfig only syncs default_agent / max_retries / timeout_minutes from config.json into SQLite (src/core/state-store.ts:1216-1246). Writing adviser_agent/adviser_model to config.json alone means the tool always reports not-configured while tenet config says it is set — and unit tests that seed via setConfig would still pass, so the bug ships. Precedent: adapter-args are read from config.json at MCP server startup (loadAdapterExtraArgs, src/mcp/index.ts:17-28, wired via src/cli/serve.ts:42-43); do the same for adviser agent/model and pass them into tool registration/JobManager explicitly.
- Agent-name resolution: startJob/createPendingJob hardcode agentName: resolveAgentName(type) (src/core/job-manager.ts:170,198); resolveAgentName reads only agent_override_<type>/default_agent (:485-492). Either special-case adviser_agent in resolveAgentName or thread an explicit agent through the adviser dispatch path — pick the one that leaves ordinary dispatch untouched.
- Adviser agent values are registry keys claude-code|opencode|codex (src/adapters/index.ts:29-33); resolveAgentName fails closed on unknown names ('no agent adapter available', job-manager.ts:643-644).
- Adviser model -> adapter: AgentInvocation has no model field, only extraArgs (src/adapters/base.ts). Pass ['--model', adviserModel] via invocation.extraArgs — placement already works per adapter: claude puts job extraArgs before --print ('so they can influence mode/model', src/adapters/claude-adapter.ts:54-55); opencode before the run subcommand (comment names --model, src/adapters/opencode-adapter.ts:69); codex between sandbox args and prompt (src/adapters/codex-adapter.ts:32).

ADVISER PROMPT — do not reuse report_only
- report_only: true produces a Report-Only Scope block (src/core/job-manager.ts:48-61, applied :815,:859-861) with wrong semantics for the adviser: it instructs calling tenet_report_blocking_finding and describes a child-dev-job resume flow; the adviser subprocess has no MCP tools and must never spawn remediation. Build a bespoke adviser preamble; the eval preamble pattern (src/mcp/tools/tenet-start-eval.ts:45-243) is the construction precedent.
- Context shape: skip the standard buildWorkerContext run-context block (src/core/job-manager.ts:810-864) for adviser jobs — give the composed question + explicit artifact path pointers instead; full-repo access is the adviser's edge over the worker's narrowed compiled context.
- Question composition stays orchestrator-side: the dev preamble actively suppresses questions ('If the task is unclear, make reasonable assumptions and implement. Do not exit without producing code.', src/core/job-manager.ts:918) and stays unchanged.

TOOL CONTRACT
- Input: question (required); optional source_job_id to derive run_path/artifact pointers from the stored job (precedent: tenet_start_eval, src/mcp/tools/tenet-start-eval.ts:566-588).
- Unset-config return: jsonResult payload adviser_configured:false + 'ask the user' guidance, not asToolError — gives the unset-config no-op test a defined shape.
- Wait/result: dispatched adviser job returns running (startJob pattern, src/core/job-manager.ts:179-224); use existing tenet_job_wait / tenet_job_result.

SKILL DOC
- No stop-and-ask step exists in phases/05-execution-loop.md (checked in full); the escalation step anchors at the orchestrator's own judgment points — eval failure handling, retry decisions, repeated-failure detection. Journal via the existing tenet_update_knowledge(type='journal') route (routes to .tenet/runs/<run-slug>/journal/).

OBSIDIAN NOTE
- Vault path: MyObsidian/03_Hermes/03_Projects/02_Tenet/2026-10-13-tenet-adviser-model-escalation.md — context only; the DESIGN in the description is authoritative where they differ. The note's three open questions are all settled by the interview: no worker transcript needed (question + repo + artifact pointers suffices), no invocation cap, and the note's auto/review human-in-the-loop tiers are replaced by the no-human-gate decision (answer returns to the orchestrator, loop continues).
<!-- SECTION:NOTES:END -->
