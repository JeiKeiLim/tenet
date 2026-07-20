# Critic Designer — authoring a custom evaluation critic

On demand. Not a numbered loop phase — read this when the user asks Tenet to
"create a <X> critic for this repo," when a run keeps hitting a failure class
the three built-in critics (code, test, interaction-e2e) under-cover, or when
**Critic Tailoring** (`phases/02-spec-and-harness.md` § 4.5) sends you here to
draft a run-scoped critic from the just-written spec.

Tenet's eval gate is configurable. The critic set lives in
`.tenet/critics.json`; each critic runs as an **independent-context eval job**
(sees the job scope + your prompt, never the author's reasoning). Grounded critics
also get the run docs (spec/harness/...) inlined; an ungrounded critic reviews from
the code alone — see `full_context` below. This doc is how you design one so it
actually plugs into the gate and the fix-routing.

## What a critic is

A critic is a focused prompt that ends by emitting a structured verdict. The
orchestrator:

- dispatches it (alongside the built-ins) on every job's eval,
- reads its `passed` flag to decide pass/fail, and
- reads each finding's `category` to route follow-up work (retry the dev job,
  strengthen tests, fix the harness, etc.).

A good critic is **narrow and specific to this repo's real risk surface** — not a
generic "review the code." "Reject any SQL query built by string concatenation"
beats "check for security issues."

## The roster file (`.tenet/critics.json`)

```json
{
  "version": 1,
  "critics": [
    { "id": "code_critic",     "builtin": true,  "enabled": true, "full_context": true },
    { "id": "test_critic",     "builtin": true,  "enabled": true, "full_context": true },
    { "id": "interaction_e2e", "builtin": true,  "enabled": true, "full_context": false },
    {
      "id": "security",
      "builtin": false,
      "enabled": true,
      "stage": "security_critic",
      "job_type": "critic_eval",
      "prompt_file": ".tenet/critics/security.md",
      "full_context": true
    }
  ]
}
```

- **Built-ins** (`builtin: true`): `enabled` and order are the usual levers
  (omit one to leave it enabled at its default position; `enabled: false` drops
  it). `full_context` is honored here too. `code_critic` and `test_critic` default
  to `true` (conformance — they check against the spec/tests); `interaction_e2e`
  defaults to `false` (it acts like a user — explore the surface, don't anchor to
  the declared spec). Set `false` on a conformance built-in, or `true` on
  `interaction_e2e`, to override either default.
  Note: the `interaction_e2e` critic handles CLI/API/library surfaces too —
  agent-brain shell e2e, not just browser — so for a CLI-only project you usually
  want it **enabled**. Only disable it if you want no public-surface e2e at all.
- **Custom** (`builtin: false`):
  - `id` — stable identifier; also the default `stage` name if `stage` is omitted.
  - `stage` — the `eval_stage` name. Must be unique across the roster.
  - `job_type` — `critic_eval` (default) or `interaction_e2e`. Use
    `interaction_e2e` only if the critic needs browser tools / emits
    `layer2_status`; otherwise `critic_eval`.
  - `prompt_file` — project-relative path to the prompt markdown. Missing file →
    the critic is skipped at dispatch with a warning (never fatal).
  - `full_context` — optional, default `true`. When `true` (default), the critic
    receives the run docs (spec/scenarios/decomposition/harness) inlined into its
    context, same as a dev worker — use this for **conformance** critics that check
    the work against the spec. When `false`, the critic gets ONLY its prompt + the
    implementation output, with NO spec inlined — use this for an **independent /
    adversarial** critic that should review without being anchored to the spec, so it
    can catch issues the spec itself missed. (The artifact_paths labels still appear in
    its job scope, so it can consult the spec on demand — independent, not blind.)
    Applies to built-ins too; the built-ins default to `true`.

The file is read live on every eval — edit it and the next `tenet_start_eval`
reflects the change with no restart. Invalid JSON falls back to the 3 built-ins.

## Two scopes: global vs run-scoped critics

Custom critics live in **two scopes**, both wired through the same roster file.
`prompt_file` is resolved as project-relative or absolute, so either path shape
just works — no code change is needed to use either scope.

- **Global (durable):** `.tenet/critics/<id>.md`. Hand-authored (via the Design
  Workflow below) for risk surfaces that apply to every run in this repo — e.g.
  a security critic for a payments API, an a11y critic for a UI project. Listed
  in `.tenet/critics.json` with `prompt_file: ".tenet/critics/<id>.md"`. Persists
  across runs; revise by hand or via the critic designer on demand.
- **Run-scoped (ephemeral):** `.tenet/runs/<run-slug>/critics/<id>.md`. Generated
  by the **Critic Tailoring** step (`phases/02-spec-and-harness.md` § 4.5) from the
  just-written interview/spec — for risks *this* feature surfaces that the
  built-ins and existing global critics under-cover. Listed in `.tenet/critics.json`
  with `prompt_file: ".tenet/runs/<run-slug>/critics/<id>.md"`. Pruned or promoted
  at run end (see *Run-end critic lifecycle* below).

The roster is the single dispatch list — it mixes global and run-scoped entries
freely. At run end, the run-scoped entries are either dropped (the default) or
promoted to global (if the critic caught a real failure this run and the risk
applies repo-wide). This keeps the roster from accumulating stale per-run critics
while preserving the ones that earned a durable place.

A run-scoped roster entry looks identical to a global one except for the path:

```json
{
  "id": "oauth-token-leak",
  "builtin": false,
  "enabled": true,
  "stage": "oauth_token_leak_critic",
  "job_type": "critic_eval",
  "prompt_file": ".tenet/runs/2026-07-20-oauth/critics/oauth-token-leak.md",
  "full_context": true
}
```

## Grounding & backward compatibility

`full_context` is optional and defaults to `true` on every critic — built-in or
custom — so any existing `.tenet/critics.json` keeps working unchanged. No
migration, no schema bump. Add `"full_context": false` to any entry when you want
that critic to review independently of the spec (no docs inlined). It is honored
on built-ins too — for example, to run `code_critic` ungrounded alongside an
ungrounded custom critic:

```json
{
  "version": 1,
  "critics": [
    { "id": "code_critic",     "builtin": true, "full_context": false },
    { "id": "test_critic",     "builtin": true },
    { "id": "interaction_e2e", "builtin": true },
    { "id": "adversarial", "prompt_file": ".tenet/critics/adversarial.md", "full_context": false }
  ]
}
```

Here `code_critic` (overridden to `false`), `interaction_e2e` (ungrounded by
default — it acts like a user), and `adversarial` (custom) review from the code
alone; `test_critic` stays grounded. Mixing is the point — diversity of grounding,
not all-or-nothing.

## Output contract (mandatory)

Every custom critic prompt MUST end by instructing the model to emit exactly this
shape — it is what the eval gate parses and what routes fixes:

```
End with: {"passed": true/false, "stage": "<your stage>", "findings": [{"category": "...", "detail": "..."}]}
```

- `passed` — `true` only if the work is acceptable for THIS critic's focus.
  A critic with no findings still emits `"passed": true`. There is no "minor /
  non-blocking": if you find something, `passed` is `false`.
- `stage` — your roster `stage` (e.g. `security_critic`).
- `findings[].category` — MUST be one of the standard enum so the orchestrator
  routes the fix correctly (see `phases/06-evaluation.md`):
  - `product_bug` — implementation doesn't match intent → retry the dev job
  - `test_bug` — tests assert the wrong thing → retry with test-strengthening
  - `harness_bug` — build/lint/test infra itself is broken → remediate infra
  - `evidence_mismatch` — report numbers contradict fresh command output
  - `contention` — looks like a sibling eval stepping on shared state
  - `scope_conflict` — work outside the job's declared scope

If a critic's output doesn't parse to this shape, the eval gate treats it as
not-passed. So end the prompt with the literal contract line above.

## Design workflow

This section covers **two entry points**: the durable global-critic workflow
(on-demand, hand-authored) and the **run-tailoring workflow** (called from
`phases/02-spec-and-harness.md` § 4.5 with the spec already in hand).

### A. Global critic (durable, on-demand)

1. **Find the gap.** Read `.tenet/project/**` (especially `testing.md`,
   `architecture.md`) and recent run journals under `.tenet/runs/*/journal/`.
   What failure class keeps slipping past the three built-ins? Pick a concrete
   focus — e.g. "authz checks," "N+1 queries," "unbounded memory," "API contract
   drift," "a11y regressions."
2. **Write the prompt** at `.tenet/critics/<id>.md`. State the focus, what counts
   as a finding, the severity rule (everything is blocking), and end with the
   output contract line. The prompt receives the job scope preamble (eval-only
   within this job) plus a `## Implementation Output` section automatically —
   tell it to inspect that output.
3. **Register** the critic in `.tenet/critics.json` with `enabled: true` and
   `prompt_file: ".tenet/critics/<id>.md"`.
4. **Smoke-test.** Run `tenet_start_eval` against one completed job, then
   `tenet_job_result` on the critic's job id. Confirm its output parses (has
   `passed` + `findings` with valid `category`) and that a deliberate violation
   in the output makes it fail.
5. **Watch reliability.** If the critic routinely fails to emit the contract,
   tighten the prompt's closing instruction before trusting its verdict.

### B. Run-tailored critic (ephemeral, called from the spec phase)

You are invoked by `phases/02-spec-and-harness.md` § 4.5 with `interview.md`,
`spec.md`, and `scenarios.md` already written for this run. §4.5 owns the full
procedure — three steps: orphan sweep → review global critics against this run's
spec → generate run-scoped critics for gaps the enabled globals don't cover.
Read §4.5 and follow it; don't re-derive the procedure here.

This section is the **prompt-shape reference** for Step 2's generate part — how
to write the critic prompt file once §4.5 has identified a gap.

- **Write the prompt** at `.tenet/runs/<run-slug>/critics/<id>.md` (create the
  directory). Same prompt shape as global critics: state the focus, what counts
  as a finding, the severity rule (everything is blocking), and end with the
  output contract line (see *Output contract* above). Use a `stage` name that
  matches the critic's focus (e.g. `oauth_token_leak_critic`).
- **Register** each run-scoped critic in `.tenet/critics.json` with
  `prompt_file: ".tenet/runs/<run-slug>/critics/<id>.md"`. Preserve all existing
  entries (built-ins + global customs, including any Step 1 disabled) — append
  only.
- **Prefer reuse over creation.** If a still-enabled global critic already covers
  the gap, do not create a run-scoped duplicate — the global one already runs on
  every eval.
- **Defer if no gaps.** If the spec surfaces no risks beyond what the built-ins
  and enabled globals already cover, write no run-scoped critic and record that
  decision in the run journal (`tenet_update_knowledge(type="journal", ...)`)
  so the run-end lifecycle step knows tailoring was considered, not skipped by
  mistake.

### Run-end critic lifecycle

At run completion (`phases/05-execution-loop.md` → *Run Completion*), after the
doctrine drift review, handle run-scoped critics before the final report:

1. **For each run-scoped critic** (roster entries whose `prompt_file` is under
   `.tenet/runs/<run-slug>/critics/`):
   - **Default: drop.** Remove its roster entry from `.tenet/critics.json` and
     leave the prompt file in `.tenet/runs/<run-slug>/critics/` (it dies with the
     run directory; no cleanup needed). This is the right call when the critic
     passed on every job it ran against, or the run had no jobs that exercised
     its focus.
   - **Promote to global** if **both** are true: (a) the critic caught at least
     one real failure this run (a `passed: false` that triggered a dev retry and
     the retry fixed the issue), and (b) the risk applies repo-wide, not just to
     this feature. To promote: move the prompt file to `.tenet/critics/<id>.md`,
     rewrite the roster entry's `prompt_file` to the new path, and note the
     promotion in the run journal.
2. **Restore disabled globals.** For any global critic Step 1 disabled for this
   run, set `enabled: true` again unless the run surfaced a reason to keep it
   off (in which case a doctrine-drift note was already written in Step 1). A
   disable is per-run by default; it must not silently persist into the next run.
3. **Never block the run** on this step. State the count (dropped / promoted /
   disabled-restored) in the final report and continue. The user can revise
   global promotions between runs by hand.

## Worked example — a security critic

`.tenet/critics/security.md`:

```markdown
## Security Critic

You are the SECURITY CRITIC. You review ONLY the Implementation Output below,
against THIS job's scope. Focus narrowly on:

- Injection (SQL, shell, template, command) — any query/command built by string concatenation.
- Secret exposure — keys, tokens, passwords logged, embedded, or committed.
- Auth/authz gaps — endpoints reachable without the required permission check.

SEVERITY RULE: every finding is blocking. A single confirmed issue → passed:false.

### Finding categories (required)
Use "product_bug" for an implementation gap, "test_bug" if a security test is
missing/weak, "harness_bug" if security tooling is misconfigured.

End with: {"passed": true/false, "stage": "security_critic", "findings": [{"category": "product_bug", "detail": "..."}]}
```

`.tenet/critics.json` entry (built-ins omitted stay enabled):

```json
{ "id": "security", "builtin": false, "enabled": true, "stage": "security_critic", "job_type": "critic_eval", "prompt_file": ".tenet/critics/security.md" }
```

Now every job's eval runs code critic + test critic + interaction-e2e + security
critic, and a security finding routes as `product_bug` (retry the dev job) — the
gate won't pass until it's fixed.
