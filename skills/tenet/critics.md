# Critic Designer — authoring a custom evaluation critic

On demand. Not a numbered loop phase — read this when the user asks Tenet to
"create a <X> critic for this repo," or when a run keeps hitting a failure class
the three built-in critics (code, test, interaction-e2e) under-cover.

Tenet's eval gate is configurable. The critic set lives in
`.tenet/critics.json`; each critic runs as an **independent-context eval job**
(sees the job scope + your prompt, never the author's reasoning). This doc is how
you design one so it actually plugs into the gate and the fix-routing.

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
    { "id": "code_critic",     "builtin": true,  "enabled": true },
    { "id": "test_critic",     "builtin": true,  "enabled": true },
    { "id": "playwright_eval", "builtin": true,  "enabled": true },
    {
      "id": "security",
      "builtin": false,
      "enabled": true,
      "stage": "security_critic",
      "job_type": "critic_eval",
      "prompt_file": ".tenet/critics/security.md"
    }
  ]
}
```

- **Built-ins** (`builtin: true`): only `enabled` (and order) matter. Omitting
  one leaves it enabled at its default position. Set `enabled: false` to drop it
  (e.g. disable `playwright_eval` for a CLI-only project).
- **Custom** (`builtin: false`):
  - `id` — stable identifier; also the default `stage` name if `stage` is omitted.
  - `stage` — the `eval_stage` name. Must be unique across the roster.
  - `job_type` — `critic_eval` (default) or `playwright_eval`. Use
    `playwright_eval` only if the critic needs browser tools / emits
    `layer2_status`; otherwise `critic_eval`.
  - `prompt_file` — project-relative path to the prompt markdown. Missing file →
    the critic is skipped at dispatch with a warning (never fatal).

The file is read live on every eval — edit it and the next `tenet_start_eval`
reflects the change with no restart. Invalid JSON falls back to the 3 built-ins.

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
3. **Register** the critic in `.tenet/critics.json` with `enabled: true`.
4. **Smoke-test.** Run `tenet_start_eval` against one completed job, then
   `tenet_job_result` on the critic's job id. Confirm its output parses (has
   `passed` + `findings` with valid `category`) and that a deliberate violation
   in the output makes it fail.
5. **Watch reliability.** If the critic routinely fails to emit the contract,
   tighten the prompt's closing instruction before trusting its verdict.

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
