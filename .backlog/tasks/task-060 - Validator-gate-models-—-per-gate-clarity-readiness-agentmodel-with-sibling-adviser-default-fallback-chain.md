---
id: TASK-060
title: >-
  Validator gate models — per-gate clarity/readiness agent+model with sibling ->
  adviser -> default fallback chain
status: Done
assignee: []
created_date: '2026-11-23 07:32'
updated_date: '2026-11-24 22:54'
labels:
  - config
  - validation-gates
  - ux
dependencies: []
references:
  - 'TASK-058 (adviser precedent: pair config'
  - model pin mechanism
  - parseAgentModelConfig
  - no-op trap)
  - TASK-004 (critic model selection — separate surface
  - boundary)
priority: high
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The two interview-time validators — tenet_validate_clarity (clarity gate, phase 01-interview) and tenet_validate_readiness (implementation readiness gate, phase 02-spec-and-harness) — are gate jobs whose purpose is independent judgment on planning artifacts, but they dispatch as plain 'eval' jobs on the same agent+model as workers. Both call startJob('eval', {prompt, eval_type, ...}) with no agentName (src/mcp/tools/tenet-validate-clarity.ts:233-236, src/mcp/tools/tenet-validate-readiness.ts:478-483), so the agent resolves via agent_override_eval ?? default_agent (src/core/job-manager.ts:525-532) and the model inherits the default_agent_model pin (src/core/job-manager.ts:835-844). The skill's independence promise is fresh-CONTEXT only; nothing in the system decouples the judging model from the worker model.

USER DECISION (2026-11-23 design conversation): each gate gets its own adviser-style agent+model pair — clarity_agent/clarity_model and readiness_agent/readiness_model — resolved through a per-gate fallback chain: own pair -> SIBLING gate's pair -> adviser pair -> default agent -> adapter CLI default. Rationale: gates are judgment work like the adviser (TASK-058), so the adviser config is the natural inherited default; per-gate pairs allow divergence (e.g. readiness on codex while clarity stays on claude-code); sibling fallback covers the set-one-gate case. A model string is only valid on its own pair's agent, so every tier is a complete agent+model pair, never a bare model on a different agent.

Scope: config plumbing + dispatch routing only. Out of scope: critic model selection (TASK-004, separate surface), skill-prose changes (independence wording is context-based and stays true), new tenet init prompts (user-approved: flags + config menu suffice; the adviser fallback covers the common case at zero setup).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New config keys clarity_agent/clarity_model/readiness_agent/readiness_model in .tenet/.state/config.json; a gate pair activates only when both its keys are non-empty, and a partially set pair behaves exactly like unset at every tier (adviser precedent)
- [x] #2 Per-gate fallback chain resolved independently for each gate: own pair -> sibling gate's pair -> adviser pair -> today's eval path (agent_override_eval ?? default_agent, with default_agent_model pinned when the job runs on default_agent) -> adapter CLI default when default_agent_model is unset; with no gate/sibling/adviser config the behavior is byte-identical to today
- [x] #3 tenet_validate_clarity's dispatched job runs on the effective clarity pair's agent with the pair's model pinned via AgentInvocation.model; tenet_validate_readiness likewise on the effective readiness pair
- [x] #4 Retry-safe: a validator job re-dispatched through tenet_retry_job (retryJob -> dispatchJob) keeps the effective gate agent and model — dispatchJob's agent re-resolution honors the gate chain instead of overwriting the stored agent with resolveAgentName('eval')
- [x] #5 The effective gate model replaces any manual --model/-m flag in the executing agent's args via the existing stripModelFlags/mergeExtraArgs mechanism, and the pin applies only when the executing adapter equals the effective pair's agent
- [x] #6 Isolation: the built-in test critic (job type 'eval' but carries eval_stage, never eval_type), critic_eval/interaction_e2e/mechanical_eval critic jobs, dev jobs, ad-hoc eval jobs without a validator eval_type, and adviser jobs are all unaffected by the gate chain at every tier
- [x] #7 Injection discriminates on job.type === 'eval' && params.eval_type in {clarity_validation, readiness_validation}; the only writers of those two values are the two validator tools (including their deterministic preflight job creations)
- [x] #8 parseAgentModelConfig reads the four new keys and both server entry points (src/mcp/index.ts and src/cli/serve.ts) pass the gate config into JobManager at startup; the keys are file-read (never the StateStore loadFileConfig whitelist, which would silently drop them)
- [x] #9 tenet config gains --clarity-agent, --clarity-model, --readiness-agent, --readiness-model (empty value clears the key); tenet config --show prints gate lines; the To-change cheat sheet lists the new flags
- [x] #10 The interactive tenet config menu gains per-gate entries that configure each pair together (agent picker, then that agent's model picker — adviser template) with a clear/unset path, and warnings fire for partially set pairs and for a configured pair whose agent's global args carry a manual model flag
- [x] #11 Both validator tools' successful dispatch responses include the effective agent and model that will judge the gate (observability consumer; reports whichever tier resolved)
- [x] #12 tenet init asks no new questions about gate config and writes no gate keys
- [x] #13 Deterministic preflight paths (Full-mode delivery gate in clarity, placeholder/front-matter preflight in readiness) complete jobs with no model dispatch and are unaffected
- [x] #14 Unit tests cover every tier of the chain for both gates, sibling symmetry in both directions, partial-pair collapse, retry preservation, test-critic isolation, parseAgentModelConfig wiring, config flags/menu/warnings, and tool response fields; make check is green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Core: extend parseAgentModelConfig (runtime-config.ts) with the four gate keys (per-gate both-required collapse) and JobManagerConfig (job-manager.ts) with the gate pairs field + effectiveGatePair/agent resolution helper (chain: gate -> sibling -> adviser) honoring the three resolution points (startJob, createPendingJob, dispatchJob re-resolution — retry safety) and the toInvocation gate branch before defaultAgentModel.
2. Tools: extend tenet-validate-clarity/tenet-validate-readiness dispatch responses with the effective agent/model (getter from JobManager); preflight paths unchanged.
3. CLI: four tenet config flags (empty clears, agent validated), two config-menu entries (pair flow via model picker), configDisplayLines gate lines incl. inherited-tier display, To-change cheat sheet, warnings (partial pair per gate; args-conflict). StateConfig type gains the keys. No init prompts.
4. Tests: full fallback-chain matrix per gate + sibling symmetry + partial collapse + retry preservation + isolation (test critic/eval_stage, adviser, dev, ad-hoc eval) + parseAgentModelConfig + config UX + tool response fields + argv assembly per adapter. Then make check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## DESIGN — FALLBACK CHAIN (user decisions, 2026-11-23)

Effective pair per gate, first tier that yields a COMPLETE pair wins:

| Tier | Source | Notes |
|---|---|---|
| 1 | Own pair (clarity_agent+clarity_model / readiness_agent+readiness_model) | both keys required; partial = unset at this tier |
| 2 | Sibling gate's pair | clarity unset + readiness set -> readiness pair judges clarity, and vice versa; symmetric, never loops |
| 3 | Adviser pair (adviser_agent+adviser_model from TASK-058) | both empty + adviser configured -> gates run on the adviser model |
| 4 | Today's eval path untouched | resolveAgentName('eval') = agent_override_eval ?? default_agent, with default_agent_model pinned when the executing adapter is default_agent |
| 5 | Adapter CLI default | tier 4 with default_agent_model unset — identical to today's unpinned behavior |

Semantics rules:
- Every tier 1-3 is a complete agent+model PAIR, never a bare model on a different agent — model strings are per-CLI (claude aliases / codex catalog / opencode provider:model), so a model is only meaningful paired with its agent. Inheriting "adviser model" means inheriting the adviser PAIR.
- A partially set pair at any tier collapses to unset AT THAT TIER and falls to the next tier; a partial-pair warning fires at config time (adviser precedent: parseAgentModelConfig collapses partial adviser to undefined, src/core/runtime-config.ts:70-81).
- Tiers 1-3 come from startup-frozen file keys (config.json via parseAgentModelConfig — one lifetime); tier 4's agent_override_eval/default_agent are DB-read at dispatch. Do NOT mix the gate chain into the DB store: compute tiers 1-3 from JobManager fields, and only when none of them resolves does the existing DB path run untouched.
- "Nothing configured anywhere" (no gate, no sibling, no adviser) must be byte-identical to today: the job flows through resolveAgentName('eval') + the defaultAgentModel pin exactly as now.

Consequence (intended): this changes behavior for every project with an adviser configured — their gates move to the adviser agent+model automatically. That is the fallback working as designed; note it in the release notes when this ships.

## DESIGN — DISPATCH MECHANICS

Discriminator: job.type === 'eval' && params.eval_type ∈ {clarity_validation, readiness_validation}. Writers of those values (verified, only 4 in src/): tenet-validate-clarity.ts:105 (deterministic failure job) and :235 (real dispatch); tenet-validate-readiness.ts:390 (deterministic failure job) and :480 (real dispatch). Reader precedent in core: persistReadinessVerdict already branches on params.eval_type === 'readiness_validation' (src/core/job-manager.ts:1066-1091). Do NOT key on job type alone: the built-in test critic also dispatches as type 'eval' (src/core/critic-roster.ts:34-47 maps test_critic -> 'eval') but carries eval_stage, never eval_type (src/mcp/tools/tenet-start-eval.ts:566-588 buildParams sets eval_stage) — so eval_type isolates the two gates from the test critic, every critic_eval/interaction_e2e job, and ad-hoc evals.

Agent forcing — THREE resolution points, all must honor the chain:
1. startJob (src/core/job-manager.ts:195-216): agentName = opts?.agentName ?? effectiveGateAgent(type, params) ?? resolveAgentName(type). Validators dispatch immediately via startJob -> executeJob, so the first run uses this.
2. createPendingJob (job-manager.ts:177-193): deterministic preflight jobs never dispatch (status flipped to completed directly, no adapter.invoke), but stamp the agent consistently for display.
3. dispatchJob re-resolution (job-manager.ts:138-148): today it re-resolves via resolveAgentName(job.type) and OVERWRITES the stored agent_name for every non-adviser job (markJobRunning writes the agent_name column, src/core/state-store.ts:602-619). Without a fix here, tenet_retry_job on a validator job (retryJob -> dispatchJob, job-manager.ts:343-390) silently drops the gate agent+model on retry. The adviser avoided this class of bug by having a dedicated job type gate the preservation; validators share 'eval', so the chain must be checked in this re-resolution: effectiveGateAgent(job.type, job.params) ?? resolveAgentName(job.type).

Model pin — toInvocation (job-manager.ts:835-844): insert the gate branch BEFORE the defaultAgentModel branch. Pseudocode:
  const gatePair = job.type === 'eval' ? effectiveGatePair(job.params.eval_type) : undefined;  // gate ?? sibling ?? adviser
  if (gatePair) {
    if (adapterName === gatePair.agent) model = gatePair.model;   // replaces manual --model via AgentInvocation.model + stripModelFlags/mergeExtraArgs (src/adapters/base.ts:19-51)
  } else if (this.defaultAgentModel && adapterName === this.stateStore.getConfig('default_agent')) {
    model = this.defaultAgentModel;                                // today's branch, unchanged
  }
adapterName here is the EXECUTING adapter's registry name (passed at job-manager.ts:594), not job.agentName. When a gate pair resolves, the agent was already forced to gatePair.agent at the resolution points above, so the equality holds; the equality guard is still required for the edge where the pair's agent equals the default agent (same agent, different model — that case must work too: gate model wins over default_agent_model).
- Adviser jobs keep their existing branch untouched (job.type === 'adviser' checks first).
- JobManagerConfig gains a gate field, e.g. gateValidators?: { clarity?: {agent: string; model: string}; readiness?: {agent: string; model: string} } (mirrors adviser?: AdviserConfig, job-manager.ts:64-73, 106-113).
- effectiveGatePair resolution helper lives on JobManager (needs this.adviser for tier 3); expose a small getter (e.g. getEffectiveGatePair(evalType) | isGateConfigured(evalType)) so the two tools can report the effective pair in responses without duplicating chain logic.
- No DB migration: jobs.type is unconstrained TEXT and validators already exist as 'eval' (TASK-058 precedent T58:69); params flow through the jobs.params JSON column today.

## DESIGN — CONFIG UX SURFACE

- Keys: clarity_agent, clarity_model, readiness_agent, readiness_model in .tenet/.state/config.json (adviser naming family; "clarity gate"/"readiness gate" match the phase vocabulary — skills/tenet/phases/01-interview.md "Clarity Gate Mechanics", 02-spec-and-harness.md "Implementation Readiness Gate").
- parseAgentModelConfig (src/core/runtime-config.ts:56-84) reads the four keys; each gate pair collapses independently: clarity = clarityAgent && clarityModel ? {agent, model} : undefined, same for readiness. Return shape gains the gate pairs. CRITICAL TRAP (TASK-058 lesson, T58:72 "silent no-op trap"): these keys must be read from the raw config.json file at server startup, NOT via StateStore loadFileConfig — its whitelist syncs only default_agent/max_retries/timeout_minutes into the SQLite config table (src/core/state-store.ts:1216-1241), so a DB-read key would be silently unset while tenet config claims it is set. Both entry points already spread parseAgentModelConfig(rawStateConfig) into the JobManager config (src/mcp/index.ts:18-28,56-61 via loadRawStateConfig; src/cli/serve.ts:43-48 via readStateConfig) — extending the return object flows the new field automatically once JobManagerConfig accepts it.
- CLI flags (src/cli/index.ts config command, current flags at 813-855): --clarity-agent, --clarity-model, --readiness-agent, --readiness-model; empty value clears the key (applyAgentModelFlags template in src/cli/init.ts, which validates agent keys against ADAPTER_KEYS before mutation — extend the shape for two pairs). Invalid agent values rejected pre-mutation (adviser precedent: --adviser-agent validated).
- Interactive config menu (src/cli/index.ts:395-441, sub-flow templates at 274-360): two new entries — "Clarity validator", "Readiness validator" — each setting the pair together (pick agent via promptAgent-style flow, then model via the per-agent model picker src/cli/model-picker.ts) with a clear/unset option. Adviser template = pickAdviserConfig flow (writes both keys together).
- Display: configDisplayLines (src/cli/init.ts:475-491) gains gate lines (show "inherited from adviser" or "inherited from <sibling>" when the effective tier is not the gate's own pair — this is the UX surface where the fallback chain becomes visible); printConfigDisplay To-change cheat sheet (src/cli/index.ts:246-264) gains the four flags; printConfigWarnings (src/cli/init.ts:359-407) gains (a) partial-pair warning per gate ("both keys required", adviserConfigWarning template) and (b) args-conflict warning when a resolved gate pair's agent's global <agent>_args carries a manual --model flag (defaultAgentModelArgsWarning template — the pinned model REPLACES manual flags via stripModelFlags, src/adapters/base.ts:43-52, so the user must know their args flag is being overridden).
- tenet init: NO new prompts, no gate keys written (user-approved; adviser fallback covers the common case, flags/menu are the expert surface). --show and non-TTY output flow from configDisplayLines automatically.
- Model picker reuse: pickModelForAgent works per-adapter (claude static alias menu — never probe, unrecognized words start a BILLED session; codex via 'codex debug models' filtered to visibility 'list' — never 'codex models' (TUI); opencode 'opencode models' two-step; manual free-text escape everywhere; cross-spawn.sync for Windows .cmd shims). Gate pairs may target ANY registered agent, not just the default agent.

## DESIGN — OBSERVABILITY (consumer for the new config)

Both validator tools' successful dispatch responses currently return {job_id, message, ...}. Add the effective pair the job will run on, e.g. {job_id, validator_agent: "claude-code", validator_model: "opus", message} — reporting whichever tier resolved, including the inherited adviser/sibling/default tiers (when nothing resolves above tier 4, report the resolved default-agent tier or omit with a clear default). Consumer: the orchestrator journals gate results (journal-first pattern), so the model that judged each gate lands in the run journal; without this field there is NO record anywhere of the effective model (jobs table stores agent_name but no model; events carry only job type — verified during investigation). The deterministic preflight failure paths return before dispatch and stay unchanged (no agent involved).

## TEST EXPECTATIONS

Unit (mock-adapter, non-spawning — repo convention):
1. Fallback chain, per gate, every tier: own pair -> sibling pair -> adviser pair -> default path -> CLI default (assert AgentInvocation.model + agentName per tier, both gates).
2. Sibling symmetry both directions (clarity-only set; readiness-only set).
3. Partial-pair collapse: clarity_agent without clarity_model falls through to sibling/adviser (and warning fires at config layer).
4. Same-agent-different-model: gate pair on the default agent with a model different from default_agent_model -> gate model wins (pin equality is against the pair's agent, and the branch precedes defaultAgentModel).
5. Retry preservation: validator job through retryJob -> dispatchJob keeps gate agent+model (regression for the dispatchJob re-resolution overwrite, job-manager.ts:138-148).
6. Isolation: test critic (type 'eval' + eval_stage, no eval_type), critic_eval/interaction_e2e jobs, dev jobs, ad-hoc startJob('eval') WITHOUT validator eval_type, and adviser jobs — none receive a gate pair at any tier; defaultAgentModel pin for them unchanged.
7. parseAgentModelConfig: four new keys, per-gate collapse, partial = unset (extend the existing end-to-end config.json -> parseAgentModelConfig -> serve-shaped JobManager test pattern from tenet-ask-adviser.test.ts).
8. Config UX: flags set/clear, --show lines incl. inheritance display, menu flow, warnings (partial pair; args-conflict), invalid agent rejected pre-mutation.
9. Tool responses: effective agent/model reported on dispatch; preflight failure paths unchanged.
10. Manual model flags in args replaced (not duplicated) for gate jobs — stripModelFlags/mergeExtraArgs behavior already covered in adapter.test.ts; add gate-pair argv assembly cases per adapter.

## KNOWN WARTS (pre-existing, explicitly OUT OF SCOPE — do not fix here)

- Ad-hoc tenet_start_job(job_type='eval', params={eval_type:'readiness_validation'}) can already spoof persistReadinessVerdict and poison eval_parallel_safe:<feature> today (tenet-start-job.ts params is an untyped record); with this change the same spoof could reach the gate agent. Same trust boundary (the orchestrator is the caller); noted, not guarded. If the user wants a guard later, it is a separate small task.
- tenet_set_agent MCP tool is unregistered dead code (src/mcp/tools/tenet-set-agent.ts registers but registerAllTools never imports it — src/mcp/tools/index.ts:19 comment says CLI-only, and no CLI implements it either); agent_override_* therefore has NO live setter (phantom knob). Do not build on it; do not remove it here either.
- 07-agile-checkpoints.md:105 re-runs readiness with feature-only lookup (no artifact_paths), which phase 02 itself labels a warning fallback.

## INVESTIGATION EVIDENCE (9-agent grounding workflow, 2026-11-23; all 3 adversarial verdicts CONFIRMED at HEAD 26.11.1)

- Validator dispatch sites: tenet-validate-clarity.ts:233-236, tenet-validate-readiness.ts:478-483 (startJob('eval', {prompt, eval_type}); deterministic preflight at clarity:96-125, readiness:379-405 — jobs completed without adapter.invoke).
- Adapter resolution: resolveAgentName(type) = getConfig('agent_override_' + type) ?? getConfig('default_agent') (job-manager.ts:525-532); getConfig reads the SQLite config table (state-store.ts:1177-1185); startJob stamps opts?.agentName ?? resolveAgentName(type) (job-manager.ts:216; createPendingJob at 186 never takes an override); dispatchJob re-resolves and OVERWRITES agent_name for non-adviser jobs (job-manager.ts:138-148, markJobRunning state-store.ts:602-619); selectAdapter fails closed on unregistered/unavailable agents (job-manager.ts:673-689).
- Model pin: exactly two branches today (job-manager.ts:835-844) — adviser (job.type==='adviser' && this.adviser && adapterName===this.adviser.agent -> adviser.model) else defaultAgentModel when adapterName===getConfig('default_agent'); comments at 841-843 state per-type override agents keep their CLI default (no per-type model key exists). Pinned model rides AgentInvocation.model -> mergeExtraArgs strips manual --model/-m and appends the pin (base.ts:19-51; codex hard-errors on duplicate --model — live-verified during TASK-058).
- test_critic shares job type 'eval' (critic-roster.ts:34-47); critic buildParams sets eval_stage only (tenet-start-eval.ts:566-588); critics dispatch via startJob or chained createPendingJob + auto_dispatch (tenet-start-eval.ts:623-634) — no eval_type ever.
- Config wiring: parseAgentModelConfig reads adviser_agent/adviser_model/default_agent_model (runtime-config.ts:56-84); spread into JobManager config in BOTH entry points (mcp/index.ts:56-61, cli/serve.ts:43-48); loadFileConfig whitelist (state-store.ts:1216-1241) is the silent-no-op trap for new keys.
- Skill text: zero model mentions around the gates; independence wording is context-based (01-interview.md:70 "independent agent", 02-spec-and-harness.md:227 "fresh agent"); no skill change needed for this feature.
- TASK-004 (Critic model selection, To Do, high) is the eval-critic surface (critic-roster.ts CriticRosterEntry has no model field) — separate task, stays separate. TASK-058 AC#11 introduced default_agent_model — the mechanism behind the reported shared-model behavior.
- Cost template from TASK-058 (commit 0236806): core dispatch mechanism small (job-manager +72, base.ts +43, runtime-config +41, tool ~193), CLI/config UX dominated (~1300 lines: cli/index.ts +497, cli/init.ts +263, model-picker 318, select 227). Expect the same ratio; the pickers/widgets all exist now, so this task's UX cost is mostly flags/menu/warnings/display.

IMPLEMENTATION PROGRESS (2026-11-25): All four plan steps complete; make check green (501 tests / 34 files, was 461/33). Core: runtime-config.ts gained GateValidatorsConfig + resolveGatePair (single chain source shared by JobManager and the CLI display/warnings) + parseAgentModelConfig reads the four gate keys with per-gate collapse. job-manager.ts: gateValidators field; GATE_EVAL_TYPES + gateKeyForEvalType discriminator (eval_type only, never job type); effectiveGatePairForJob/effectiveGateAgent honored at all three resolution points (startJob opts?.agentName ?? gate ?? resolveAgentName; createPendingJob; dispatchJob re-resolution for retry safety); toInvocation gate branch BEFORE defaultAgentModel (pin only when executing adapter === pair agent; gate model beats default_agent_model on the same agent via branch order; gate pair present suppresses the defaultAgentModel fallback entirely per design); public getGateDispatchInfo for tool observability. Tools: both validator dispatch responses now include validator_agent + validator_model ('CLI default' when unpinned); preflight paths unchanged. CLI: four config flags wired through applyAgentModelFlags (empty clears, invalid gate agent rejected pre-mutation alongside adviser), gateFlagLog, --show gate lines + inherited-from sibling/adviser notes, To-change cheat sheet, config help text (Validator gates section), two interactive menu entries (configure pair via pickAgentPair - the pickAdviserConfig generalization - or clear both keys), describeGateChoice labels, per-gate gateConfigWarning + gateModelArgsWarning (fires for inherited tiers too) collected in printConfigWarnings. No init changes. Tests: new runtime-config.test.ts (parseAgentModelConfig + resolveGatePair chain), job-manager.test.ts gate describe (tier 1 both gates, sibling symmetry both directions, adviser tier, default tier 4/5 byte-identical, agent_override_eval precedence, same-agent-different-model, retry preservation regression, createPendingJob stamp, isolation matrix, getGateDispatchInfo tiers), both tool test files (tier 1, sibling, default-tier report incl. CLI default, server-startup config.json wiring pinning the loadFileConfig trap, preflight response unchanged), init.test.ts (isGateConfigured, gateConfigWarning, effectiveGatePair chain, gateModelArgsWarning incl. inherited tier, flag set/clear/invalid/trims, display lines incl. inheritance, config round-trip). DoD smoke test against built dist CLI verified: both pairs set, sibling inheritance note, adviser inheritance note, partial-pair warning + collapse to adviser, args-conflict warning (fires for the inherited gate too), invalid agent rejected pre-mutation (exit 1, config unchanged). Interactive menu entries are untestable in this harness (no TTY menu test precedent in the repo; flags/warnings/display are the testable surfaces). Adversarial 4-dimension review workflow running pre-finalization.

ADVERSARIAL REVIEW (2026-11-25, 28-agent workflow: 4 dimension reviewers + 3-skeptic verification per finding; ~1.8M subagent tokens): 8 raw findings -> 5 CONFIRMED, 3 refuted. The dispatch-core dimension returned zero findings. All 5 confirmed findings fixed in the same session: (1) MAJOR, AC#8 — entry-point wiring had zero direct coverage; mutation-verified that breaking BOTH real entry points (dropping gateValidators from the spread) kept all 501 tests green. Fix: new exported jobManagerConfigFromStateConfig factory in job-manager.ts consumed by BOTH entry points (they no longer spread parseAgentModelConfig themselves) + direct unit test pinning the full config shape + both tool wiring tests now exercise the real factory. (2) gateModelArgsWarning missed the -m/-m= manual model forms that stripModelFlags actually strips (AC#5 names --model/-m); fixed with a mentionsModelFlag helper detecting all four forms, smoke-verified against built CLI. NOTE: pre-existing defaultAgentModelArgsWarning shares the -m gap — TASK-058 territory, deliberately left unchanged here (new wart noted in KNOWN WARTS). (3) Menu testable semantics lived only in index.ts (untestable at import time): describeGateChoice + clearGatePair moved to init.ts per the repo's own documented convention, now unit-tested. (4) AC#11 tier reporting was only tested in sibling-symmetric configs — a swapped getGateDispatchInfo gate key passed every test (mutation-verified); fixed with distinct-pairs tier-1 tests per gate + adviser-tier + tier-4-with-pinned-model response tests. (5) AC#6 isolation test omitted interaction_e2e and mechanical_eval; added both carrying STRAY eval_type params (pinning the job.type guard), plus a source-scan writer pin (tool-names.test.ts precedent) asserting the two gate eval_type literals appear only in the two validator tools + job-manager.ts. make check green after fixes: 510 tests / 34 files.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Per-gate validator agent+model config for the two interview gates: clarity_agent/clarity_model and readiness_agent/readiness_model, resolved through own pair -> sibling gate pair -> adviser pair -> today's eval path -> adapter CLI default (complete pairs only; partial pairs collapse to unset at their tier). The chain holds at all three agent-resolution points (startJob, createPendingJob, dispatchJob re-resolution) so gate routing survives tenet_retry_job; the effective model is pinned via AgentInvocation.model only when the executing adapter equals the pair's agent and beats default_agent_model on the same agent. Both validator tools' dispatch responses report validator_agent/validator_model (the only record of the judging model). CLI: four tenet config flags (empty clears, invalid agent rejected pre-mutation), per-gate interactive menu entries with clear path, --show gate lines with inherited-from sibling/adviser notes, partial-pair and model-flag-conflict warnings (all four --model/--model=/-m/-m= forms); tenet init unchanged. Verified by 510-test suite (full chain matrix per gate, sibling symmetry, partial collapse, retry preservation, isolation matrix incl. stray-eval_type interaction_e2e/mechanical_eval, entry-point factory pin, eval_type writer source-scan, tool response tiers), a DoD smoke test against the built CLI (all fallback tiers via tenet config --show + warnings), and a 28-agent adversarial review whose 5 confirmed findings (1 major: untestable entry-point wiring) were all fixed with regression tests in the same session.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Fallback chain verified with a smoke test against the built CLI: set pairs at various tiers in a temp project config and confirm tenet config --show output
<!-- DOD:END -->
