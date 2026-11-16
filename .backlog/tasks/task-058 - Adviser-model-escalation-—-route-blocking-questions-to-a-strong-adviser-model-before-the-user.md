---
id: TASK-058
title: >-
  Adviser-model escalation — route blocking questions to a strong adviser model
  before the user
status: Done
assignee:
  - '@JeiKeiLim'
created_date: '2026-11-11 22:07'
updated_date: '2026-11-15 23:19'
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
- [x] #1 tenet config accepts --adviser-agent and --adviser-model; when unset, all behavior is unchanged (orchestrator asks the user, exactly as today)
- [x] #2 The adviser job prompt enforces read-only-by-instruction and requires either a grounded recommendation with evidence (file:line citations) or a 'genuinely user's call' distilled decision frame
- [x] #3 The skill execution loop (phases/05-execution-loop.md) documents the escalation step: before stopping to ask the user, the orchestrator dispatches the adviser when one is configured and feeds the answer back into the loop; each escalation is journaled (question, adviser evidence, decision taken)
- [x] #4 Unit tests with the non-spawning test doubles (MockAdapter/FakeAdapter) cover configured dispatch, unset-config no-op, and the answer-return path
- [x] #5 New MCP tool tenet_ask_adviser dispatches an adviser job through the configured adapter with the adviser model and the escalation question; the name is added to TENET_MCP_TOOL_NAMES (auto-updates .claude/settings.local.json and .codex/config.toml) AND to skills/tenet/SKILL.md frontmatter allowed-tools (manually enumerated; the drift test does not cover it); CLAUDE.md and README.md tool counts update from 19 to 20
- [x] #6 'adviser' is added to all three JobType enumeration surfaces: the Job type union (src/types/index.ts), the jobTypeSchema Zod enum (src/mcp/tools/utils.ts — also fix its pre-existing drift: it omits integration_test), and the JOB_TYPES array driving *_args_<jobtype> lookup (src/adapters/index.ts); adviser_job is not marked 'dev' — checkDeliverables would fail a text-only recommendation
- [x] #7 adviser_agent and adviser_model reach the MCP tool via the server-startup config.json read (adapter-args precedent, src/mcp/index.ts loadAdapterExtraArgs), not the StateStore loadFileConfig whitelist; a test covers the configured path end-to-end: config keys -> tool -> dispatched adviser job with ['--model', <adviser_model>] in invocation extraArgs
- [x] #8 tenet init interactively offers adviser setup (skippable, default = unset), and bare 'tenet config' in a TTY opens an interactive config menu covering all config keys with current values shown; 'tenet config --show' becomes the display-only form; non-TTY bare config falls back to today's display; all flags keep working unchanged, including new --adviser-agent / --adviser-model (non-interactive equivalent: tenet init --adviser-agent <key> --adviser-model <model>)
- [x] #9 All choice lists in the init/config flow use one shared selector widget (raw-mode readline, no new dependency): arrows move the highlight, number keys jump the highlight WITHOUT committing (user verifies the selection), Enter commits, Esc/q cancels with no change; the widget serves the config menu, default-agent picker, adviser-agent picker, and adviser-model pickers (claude-code: static alias menu; codex: live 'codex debug models' filtered to visibility 'list'; opencode: provider->model two-step from 'opencode models'), each with a manual-name escape entry; free-text inputs (custom model names, adapter args, retries/timeout) remain typed prompts
- [x] #10 Adviser configuration is one chained flow, not two independent entries: the config menu has a single 'Adviser' entry (showing agent / model), and selecting it runs agent picker then model picker, writing both keys together; Esc/q at any step cancels the whole flow with no write; the adviser is ACTIVE only when both adviser_agent and adviser_model are set — a partially configured adviser (one key set via flags) is treated as unset, with a warning printed by tenet config and reflected in the tool's not-configured response
- [x] #11 Default-agent configuration gains a first-class model key: config menu entry 'Default agent' chains agent picker -> model picker (same widgets), init's agent question chains the same way; new key default_agent_model applies to jobs dispatched on default_agent via the same extraArgs injection as the adviser model; unset = adapter CLI default (today's behavior); the picker's first option is 'CLI default (unset)' (worker-only — the adviser requires both keys); tenet config accepts --agent-model for the flag form
- [x] #12 tenet config --help and tenet init --help document every new flag and behavior: --agent-model, --adviser-agent (valid keys: claude-code, opencode, codex), --adviser-model, --show (display-only form), and the empty-string-clears convention; flag descriptions match actual behavior
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Core+tool: 'adviser' JobType in all 3 enum surfaces (union, jobTypeSchema + integration_test drift fix, JOB_TYPES); tenet_ask_adviser MCP tool (question + source_job_ids[] + context_pointers, bespoke adviser preamble built in the tool, not-configured payload, no worker run-context); JobManager config slots adviser{agent,model} + defaultAgentModel with extraArgs --model injection; config.json server-startup read in mcp/index.ts + serve.ts via one shared helper. 2. CLI UX: --adviser-agent/--adviser-model/--agent-model flags with ''-clears and both-keys-required warning; bare 'tenet config' interactive menu + '--show'; shared selector widget (raw-mode readline, arrows+number-highlight+Enter, windowed scroll); per-adapter model pickers (claude alias menu, codex debug models, opencode provider two-step, manual escape each); init chains agent->model->adviser offer with -y/flag gating. 3. Skill docs: SKILL.md allowed-tools; phases/05 'Escalation to adviser' section (trigger shapes, always-call pattern, journal-first, eval-gate exemption, no-gate-bypass); CLAUDE.md/README 19->20. 4. Tests: tool unit tests (configured dispatch/unset no-op/answer-return), job-manager context+injection tests, config end-to-end via MockAdapter; full make check gate. Executed via sonnet workflow agents: 3 parallel implementers -> test+fix pass -> AC/correctness review -> main-loop fixes.
<!-- SECTION:PLAN:END -->

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

MODEL PICKER — enumeration research (2026-11-12, live probes on this machine + official docs; claude-code-guide + codex research agents):

ADAPTER MODEL ENUMERATION
- opencode (1.18.35): 'opencode models' works non-interactively — one 'provider/model' per line (66 models locally); positional provider filter ('opencode models <provider>') cuts it to a handful; '--refresh' re-caches from models.dev. No --json flag; plain lines are parseable.
- claude-code (2.1.319): NO enumeration command exists — subcommands are agents/attach/auth/auto-mode/doctor/gateway/import/install/logs/mcp/plugin/purge/respawn/rm/setup-token/stop/update/ultrareview; no model subcommand, no --list-models (verified: 'claude --list-models' -> unknown option, exit 1). TRAP: unrecognized non-flag words fall through to the positional PROMPT — 'claude models' / 'claude model list' STARTS A BILLED SESSION with that text as the prompt. Never probe claude with list-ish subcommands. The only enumeration surface is the interactive /model picker. Design answer: static numbered alias menu; current alias set per https://code.claude.com/docs/en/model-config.md — default (clears override), best, fable, sonnet, opus, haiku, sonnet[1m], opus[1m], opusplan, opusplan[1m]; full IDs like claude-opus-5-5 also valid, provider/release-dependent, no enumerated list exists.
- codex (0.143.0 local; latest 0.167.1): 'codex debug models < /dev/null' works non-interactively — JSON catalog with slug/display_name/visibility ('list' = pickable)/priority per model (bundled + ~/.codex/models_cache.json 300s TTL + live refresh when authenticated). TRAP: 'codex models' is NOT a command — unrecognized args are forwarded to the interactive TUI and fail non-TTY ('stdin is not a terminal', exit 1). Filter the picker to visibility=='list'. Catalog is version-stale-prone: local 0.143.0 reports the gpt-5.x set (gpt-5.5 default) while current docs (https://learn.chatgpt.com/codex/models) list the gpt-6 family (gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra — needs CLI 0.159.0+, gpt-6-luna) — enumerate LIVE, never hardcode.

INVALID-MODEL BEHAVIOR (why number-picking matters)
- claude: FAIL FAST — exit 1 in ~1-2s, no fallback, structured stderr diagnostic [claude-code:unrecognized_model]; with --output-format json the result doc has is_error:true / api_error_status:404 / terminal_reason:'api_error' (CAVEAT: subtype stays 'success' — check is_error/terminal_reason, not subtype). COUNTER-CASE: setting --fallback-model silently swallows an invalid primary (chain fires, exit 0) — so the adviser dispatch MUST NOT set --fallback-model.
- codex: NO up-front error — warns ('Model metadata for X not found. Defaulting to fallback metadata...') and proceeds degraded; the server-side response to unknown slugs could not be verified locally (this machine's codex ChatGPT auth refresh currently 401s — codex exec fails at the auth layer here, unrelated to model choice). Environment note for the maintainer: local codex 0.143.0 vs latest 0.167.1, auth needs re-login.

PICKER UX (user request: choose model by NUMBER to avoid human error; scrollable selection for long lists)
- Keep Tenet's zero-dep readline pattern (existing promptYesNo/promptAgent, src/cli/init.ts:326-370): numbered selection everywhere, no new TUI dependency, no scrollable widget needed.
- claude: static alias menu (fable/opus/sonnet/haiku/best/opusplan) + 'custom' free-text entry.
- codex: live-enumerate from 'codex debug models', filter visibility=='list', number them (small set).
- opencode: two-step provider -> model ('opencode models <provider>') so the 60+ row list is never rendered; number both steps.
- All three pickers end with a manual-name escape hatch; free-text entries are stored verbatim (claude fails fast at dispatch on typos; codex degrades — the enumeration is the typo guard).

SELECTOR WIDGET (2026-11-13, user decision — supersedes the 'existing numbered promptAgent flow' phrasing in earlier drafts):

UX SPEC
- One shared widget for every choice list in the init/config flow: config main menu, default-agent picker, adviser-agent picker, adviser-model pickers (all three adapters), opencode provider step.
- Arrows move the highlight; typing a number jumps the highlight to that row WITHOUT committing (user checks what is actually highlighted); Enter commits; Esc/q cancels with no change.
- Uniform across every selection; the only non-widget inputs are true text entry (custom model name, adapter args, max-retries/timeout numbers) and yes/no confirms (promptYesNo stays typed).
- Lists longer than the visible window (e.g. opencode models per provider) scroll within the widget: fixed window (~10 rows), arrows scroll past edges, numbers address the visible window.

IMPLEMENTATION
- Build it on raw-mode readline + keypress events (~100 lines: process.stdin.setRawMode(true), readline.emitKeypressEvents, render rows with a highlight marker, maintain highlight index, window offset for long lists). NO new TUI dependency — off-the-shelf selectors (@clack/prompts, inquirer) commit immediately on number keys, which violates the user's number-highlight-then-verify requirement, so the bespoke behavior is wanted anyway and zero-dep keeps Tenet's dependency surface unchanged.
- promptAgent (src/cli/init.ts:342-370) is reimplemented on top of the widget (init and config share it — one implementation, no drift). promptYesNo unchanged.
- Exit/edge cases: Ctrl-C = cancel cleanly (restore cooked mode, no partial writes); widget writes config only after Enter commits an edit; cancel paths never write.
- This grows TASK-058 beyond adviser-only scope: it also upgrades init's agent picker to the widget and restructures bare 'tenet config' (interactive menu) + '--show' (display). Scope growth is user-approved (2026-11-13: 'uniform UX for that except text input required').

ADVISER CONFIG AS ONE CHAINED FLOW (2026-11-13, user decision):
- The model picker is agent-dependent (claude -> alias menu; codex -> debug models; opencode -> provider step), so adviser agent and adviser model are ONE logical unit. The interactive config menu shows a single 'Adviser: <agent> / <model>' entry; selecting it chains agent picker -> model picker and writes both keys together. Esc/q anywhere cancels the entire flow with no write. Init's adviser setup uses the same chained flow.
- Activity contract: adviser is active only when BOTH adviser_agent and adviser_model are set. Partial configuration via flags (one key only) = treated as unset: tenet config prints a warning, the tenet_ask_adviser not-configured response applies. The interactive flow never writes one key without the other.

DEFAULT_AGENT_MODEL — first-class worker model config (2026-11-13, user decision):
- Wart being fixed: today the only way to pin a worker model is hand-writing '--model ...' into claude_args/opencode_args/codex_args (the config help's own example shows this) — typo-prone, unverifiable.
- New key: default_agent_model. Applies to jobs dispatched on default_agent, injected via the same ['--model', X] extraArgs mechanism built for the adviser. Unset = adapter CLI's own default = today's behavior exactly.
- UX: identical chaining as adviser — config menu 'Default agent' row shows 'agent / model', selecting runs agent picker -> model picker; init's agent question chains into the same model step; the worker model picker's first option is 'CLI default (unset)' (the adviser flow has no such option — adviser requires both keys).
- Conflict contract (decided): default_agent_model WINS over a manual '--model' in *_args; tenet config warns when both are detected. Jobs on agent_override_<type> agents use that agent CLI's default unless args say otherwise — NO per-type model overrides now (no observed need; do not extrapolate the plumbing).
- Flag form: tenet config --agent-model <model> (pairs with --adviser-agent/--adviser-model).
- Scope note: TASK-058 now covers the full agent/model config story (adviser + worker model + interactive config UX); the shared widget and injection plumbing are why it stays one task.

FLAG PARITY (2026-11-13, user confirmation — every interactive setting has a flag form; flags never prompt):
- tenet config: --agent <name> (exists), --agent-model <model> (new), --adviser-agent <key> --adviser-model <model> (new), --max-retries/--timeout (exist), all six *_args keys (exist).
- tenet init: --agent <name> (exists), --agent-model <model> (new), --adviser-agent <key> --adviser-model <model> (new) — full non-interactive setup.
- Clearing convention (matches existing *_args behavior): empty string clears that key — --adviser-agent '' / --adviser-model '' / --agent-model ''. Clearing only one adviser key leaves the adviser inactive (both-keys-required contract; warning printed).
- tenet config --show remains the display-only form; non-TTY bare config falls back to it.

INIT INTERACTIVE FLOW (2026-11-13, user decision — init uses the same widget UX as config):
- Order: (1) 'Which coding agent will you use?' on the shared widget (replaces typed promptAgent), (2) 'Model for <agent>?' on the shared widget with 'CLI default (unset)' first option — chains immediately after agent choice, (3) 'Configure an adviser for escalations?' as a typed y/N (promptYesNo, default No — consistent with init's other confirmations; not a widget), (4) if yes: adviser agent picker -> adviser model picker (chained, both keys written together).
- Existing init steps unchanged: legacy-migration Y/N on upgrade, star nudge, playwright check.
- Non-interactive: tenet init -y plus flags (--agent, --agent-model, --adviser-agent, --adviser-model) sets everything with zero prompts; missing flags = unset (adviser) / CLI default (model).

NON-INTERACTIVE INIT GATING (2026-11-13, verified against code): today promptAgent() runs only when '!options.yes' and no --agent flag (src/cli/index.ts:281) — tenet init -y is fully non-interactive. The new widget steps (model picker, adviser offer, adviser chain) MUST inherit the same gate: skipped under -y or when their flags are provided; the adviser y/N offer defaults to No under -y unless --adviser-agent/--adviser-model are both given (flags bypass the offer and write directly). Missing flags under -y = safe defaults (agent unset, model CLI-default, adviser unset). -y semantics unchanged elsewhere: never auto-runs --migrate-legacy; --skip-playwright-check / --skip-pre-approval keep working.

SUPERSESSION NOTE (2026-11-13): the PICKER UX section above predates the SELECTOR WIDGET decision — its enumeration research, per-adapter menu contents, and manual-escape-hatch rows all STAND, but its 'numbered-commit selection / no scrollable widget' phrasing is superseded by the SELECTOR WIDGET spec (numbers highlight WITHOUT committing; Enter commits; windowed scrolling for long lists). Where the two sections disagree, the SELECTOR WIDGET section wins.

RUN CONTEXT GENERATION (2026-11-13, user probe resolved a draft error):
- The adviser preamble's RUN CONTEXT block is fully auto-generated by tenet_ask_adviser from the source job record: job.run_path + job.artifact_paths (spec, harness, scenarios, interview, decomposition) — the same stored-path resolution tenet_start_eval performs. No new state, no orchestrator typing. Without source_job_id, the orchestrator passes explicit context_pointers instead.
- There is NO frozen-test registry in Tenet — an earlier illustrative preamble draft showed a 'Frozen tests: <paths>' line; that line does not exist and must not be invented. Frozen tests reach the adviser two ways: (1) the harness.md pointer (the run's declaration of acceptance/frozen tests and danger zones — adviser reads it from the repo), (2) file paths the worker cited, carried inside the composed question text. Everything else comes from full repo access + the 'cross-check all relevant tests, not just cited ones' preamble rule.
- The five RUN CONTEXT lines are: run dir, spec, harness, scenarios, decomposition (as stored on the job).

SKILL EDITS + NOT-CONFIGURED FLOW (2026-11-13, user discussion):
- Files: (1) skills/tenet/SKILL.md — add tenet_ask_adviser to frontmatter allowed-tools; at most one pointer line in the body (procedures live in phase files per the index contract). (2) skills/tenet/phases/05-execution-loop.md — new 'Escalation to adviser' section next to failure-handling/retry guidance, containing: trigger prose ('at any moment you would otherwise halt and wait for the user') with concrete shapes (repeated identical failures with unchanged approach; worker report with mutually exclusive options; change the harness forbids; spec ambiguity between frozen tests); question composition (worker report verbatim + retry history); the call; background tenet_job_wait with the usual steering discipline; act-on-answer branch (RECOMMENDATION -> typically tenet_retry_job with the recommendation as enhanced prompt, satisfying the existing new-evidence/changed-approach retry rule; GENUINELY USER'S CALL -> surface the distilled frame to the user); journaling (question/adviser evidence/decision); no-gate-bypass line (adviser answer is context for the next attempt, never a gate bypass — existing safety invariants hold). (3) Worker dev preamble unchanged.
- Not-configured flow: ALWAYS-CALL pattern — the skill calls tenet_ask_adviser at the escalation moment regardless of boot knowledge; Tenet returns adviser_configured:false + 'surface the question to the user' guidance; orchestrator asks the user exactly as today (including idling when the user is absent — the adviser is the fix for that, not the fallback). Chosen over a boot-availability flag: one code path, no boot-state dependency, nothing to sync; the unset-config test pins the response shape. (Optional visibility nicety, NOT required: tenet_get_status may report adviser_configured.)

MULTI-JOB ESCALATIONS (2026-11-13, user probe — parallel jobs share one adviser dispatch):
- source_job_id stays SINGULAR: its only role is artifact resolution, and all jobs in a run share the same run_path/artifact_paths, so any one anchor resolves the identical RUN CONTEXT lines. Multiple source IDs resolve nothing extra. Omit it (with explicit context_pointers) when no natural anchor exists.
- New optional param affected_job_ids: string[] — for parallel jobs involved in the same decision point (e.g. a dev job plus critics hitting the same wall). Precedent: tenet_add_steer already takes affected_job_ids for this shape. Recorded in the journal entry so retrospectives trace which jobs the escalation covered; the composed question carries each report's content regardless.
- One adviser dispatch per decision point, even when N jobs are affected — never re-ask the same question per job.

CORRECTION (2026-11-16, user review — DROPS affected_job_ids; supersedes the MULTI-JOB ESCALATIONS note above):
- affected_job_ids is REMOVED from the tenet_ask_adviser schema. A flat ID array cannot represent which issue belongs to which job, and it has no consumer: the adviser reads only the prompt, the journal quotes the question, and follow-up actions (retry/steer) carry their own job IDs. The steer precedent does not transfer — steers route; the adviser dispatch routes nothing. The tool input is: question (required), source_job_id (optional, artifact anchor), context_pointers (optional, when no anchor). The question text is the single carrier of multi-job context.
- Parallel jobs with DIFFERENT issues = different decision points = separate tenet_ask_adviser calls, each with its own question and source_job_id. Whether parallel failures share one root cause (one question naming both jobs in text) or are separate (several questions) is orchestrator judgment, expressed in how questions are composed — not schema structure. The 'one adviser dispatch per decision point' rule stands.

CORRECTION 2 (2026-11-16, user challenge — supersedes CORRECTION 1's singular source_job_id):
- source_job_id becomes source_job_ids: string[] (minItems 1, optional) — 'the jobs this escalation is about'. Multiple related-but-different failures in parallel = one decision point spanning several jobs = one tenet_ask_adviser call with all their IDs. RUN CONTEXT resolves from any element (all jobs in a run share run_path/artifact_paths).
- The array says WHICH jobs; the question text says WHAT each job hit — the per-job issue structure stays in the text, never in schema fields.
- Consumer justification (why this is not the dropped affected_job_ids): every Tenet job persists its params; the adviser job's record carries source_job_ids for free, making escalations traceable in the job record/journal with zero new machinery. The earlier objection was against a routing-style param; the over-application to the input schema was wrong — the input should express the escalation's actual scope (1..N).
- Unrelated issues remain separate escalations (one per decision point); grouping related parallel failures into one call is orchestrator judgment, expressed in the call itself.

POST-ANSWER FLOW (2026-11-16, user walkthrough — the follow-through after the adviser returns):
- Collect: standard tenet_job_wait/tenet_job_result — no parsing machinery anywhere. The response contract (RECOMMENDATION / GENUINELY USER'S CALL) is prompt-enforced only; a nonconforming adviser answer is still just text the orchestrator interprets with judgment. No structured verdict field (nothing would consume it).
- Journal FIRST (question / adviser evidence / decision about to be taken), then act.
- RECOMMENDATION -> typically tenet_retry_job(job, enhanced_prompt = recommendation + evidence + what prior attempts got wrong); the retry still passes the eval gate — the adviser informs the next attempt, never bypasses gates. If the recommendation reveals a run-level issue, the orchestrator amends run docs (spec/decomposition are run artifacts, orchestrator-owned during the run — NOT doctrine) and re-registers/steers affected jobs.
- GENUINELY USER'S CALL -> the ONLY interrupt: present the distilled frame, wait for the user's answer; the answer re-enters as an authoritative user decision and drives the same retry/steer mechanics.
- EDGE (adviser job itself fails — timeout, adapter unavailable, auth error): the escalation degrades to the not-configured path — orchestrator surfaces the question to the user (adviser failure never blocks or cancels worker jobs; the failed adviser job is visible in status like any failed job). Re-calling the tool for a fresh adviser attempt is orchestrator judgment, same as any retry decision; no adviser-specific retry machinery.

ADVISER JOB + EVAL GATE + WAIT SPAN (2026-11-16, user probe surfaced the gap):
- Waiting: the adviser job is waited on by the tracked sub-agent like any other in-flight job (existing Tracked Sub-Agent Delegation rule — wait->eval->wait->gather span, all ops as Tenet MCP calls; orchestrator stays responsive; inline only if spawning is impossible). No new waiting machinery.
- EVAL GATE EXEMPTION (the gap): the adviser job does NOT trigger tenet_start_eval. The skill's eval gate prose ('after every completed job') must be scoped in the new phases/05 escalation section so a completed adviser job is consumed directly via tenet_job_result — critics on a recommendation text would be pure waste. The jobs the adviser's answer UNBLOCKS still pass their eval gates normally.

IMPLEMENTED (2026-11-16, sonnet workflow: 3 parallel implementers + test/fix + AC audit + adversarial correctness review, 12 agents; findings fixed in the main session).

MECHANISM CORRECTION — pinned model rides AgentInvocation.model (src/adapters/base.ts), NOT extraArgs append: live probes showed codex hard-errors on duplicate model flags ('cannot be used multiple times'; claude is last-wins, opencode degrades) — the 'injected args land later so the key wins' assumption in earlier notes holds only for claude. base.ts mergeExtraArgs/stripModelFlags: adapters strip any manual --model/-m (space or = form) from global *_args + job-scoped *_args_<type> and place the pinned model. Adviser model binds to adviser_agent only; default_agent_model binds to jobs actually running on default_agent (never per-type overrides).

REVIEW FINDINGS FIXED (6, adversarially confirmed): (1) the duplicate---model failure above; (2) non-TTY 'tenet init --agent x' regression — interactive chain now gated on stdin TTY, promptYesNo/promptText resolve defaults on EOF instead of hanging; (3) 'tenet config' menu now requires BOTH stdin and stdout TTY (piped stdout falls back to display, matching selectFromList's precondition); (4) tenet_start_job rejects job_type 'adviser' with a pointer to tenet_ask_adviser (the generic path would dispatch it on default_agent without the preamble/gate); (5) context_pointers are used when a source_job_ids anchor resolves no run paths (pathless ad-hoc job); (6) model-picker enumeration shells out via cross-spawn.sync (npm .cmd shims on Windows; execFileSync cannot run them).

VALIDATION: make check green — clean+build+typecheck+lint+449 tests / 32 files. New tests: tenet-ask-adviser.test.ts (11: configured dispatch, unset no-op, RUN CONTEXT resolution, context_pointers fallback, answer-return, AC#7 config.json->parseAgentModelConfig->serve-shaped JobManager end-to-end, partial-pair no-op), job-manager.test.ts (+6: no worker run-context for adviser, model pin without accumulation, override-agent exclusion, deliverables-check exemption, explicit agentName, retry preservation), tenet-start-job.test.ts (adviser rejection), cli init tests (+7), adapter.test.ts (+6 strip/pin incl. argv-level: single --model, placement before --print/run/exec). AGENTS.md also carried a 19-tool count — fixed to 20 alongside CLAUDE.md/README.md.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Adviser-model escalation shipped: tenet_ask_adviser MCP tool (question + source_job_ids[] + context_pointers; bespoke read-only preamble with RECOMMENDATION / GENUINELY USER'S CALL contract; not-configured payload), 'adviser' JobType across all three enum surfaces (+ jobTypeSchema integration_test drift fix), adviser_agent/adviser_model/default_agent_model config via server-startup config.json read, selector-widget CLI (interactive tenet config menu + --show, chained adviser flow, per-adapter model pickers, non-interactive init flags with -y gating), phases/05 'Escalation to adviser' procedure (always-call, journal-first, eval-gate exemption, no-gate-bypass), and doc counts 19->20. All 12 ACs met; make check green (449 tests); 6 adversarially-confirmed review findings fixed.
<!-- SECTION:FINAL_SUMMARY:END -->
