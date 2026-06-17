# Phase 07: Agile Checkpoints And Redirects

Use this phase only when `.tenet/runs/{run_slug}/spec.md` declares `delivery_mode: agile`.

Agile mode wraps the normal autonomous loop with user review checkpoints. Per-job execution and evaluation do not change: every job still runs through MCP, compiled context, and eval gates.

## 1. Agile Flow

1. Interview ends with a recorded `## Delivery Mode Decision` selecting `agile`.
2. Pre-spec research runs normally.
3. Spec + harness are written before visuals. The spec must include `delivery_mode: agile` front matter and a `## Slice plan`.
4. Visuals produce final-product artifacts and per-slice wireframes, per `phases/03-visuals.md`.
5. Initial plan-checkpoint blocks until the user responds.
6. Readiness gate runs.
7. Decomposition fires for slice 1 only, per `phases/04-decomposition.md`.
8. Execution loop runs until slice 1 jobs complete and eval passes.
9. Use-checkpoint blocks until the user responds.
10. `approve` advances to the next slice; `redirect: ...` enters the redirect router; `done` terminates cleanly.

## 2. Initial Plan-Checkpoint

After upfront mockups produce final-product artifacts and per-slice wireframes:

1. Brief the user with concrete paths:
   - Final-product architecture: `.tenet/runs/{run_slug}/visuals/{date}-NN-architecture.html`
   - Final-product UI: `.tenet/runs/{run_slug}/visuals/{date}-NN-final-product.html`
   - Per-slice wireframes: `.tenet/runs/{run_slug}/visuals/{date}-NN-slice-M-{name}.html`
   - Slice plan: `.tenet/runs/{run_slug}/spec.md` section `## Slice plan`
2. Ask for exactly one response:
   - `approve` — proceed to readiness gate, then slice 1 decomposition.
   - `redirect: <description>` — change the plan before build starts.
   - `cancel` — abort cleanly.
3. Wait via either interactive prompt or `tenet_process_steer()` for a directive steer.
4. Do not proceed on silence.

## 3. Slice Loop

For each slice:

1. Fire decomposition for the next slice only.
2. Register only that slice's jobs with `tenet_register_jobs`.
3. Run the normal autonomous loop until all slice jobs and evals pass.
4. Run the use-checkpoint.
5. Process response:
   - `approve` — advance to the next slice.
   - `redirect: <description>` — invoke the redirect router.
   - `done` — stop even if planned slices remain.

## 4. Use-Checkpoint

After slice N passes eval, before slice N+1:

1. Confirm the slice's `integration_test` job passed.
2. Read the slice plan entry, especially `User can`.
3. Ensure the app is running or provide a clear start command.
4. Brief the user with:
   - Slice name and what they can now do.
   - URL or entry point.
   - Test credentials/setup from harness.
   - What is intentionally still out of slice.
5. Ask for exactly one response:
   - `approve`
   - `redirect: <description>`
   - `done`
6. Wait via interactive prompt or directive steer. Do not advance on silence.

## 5. Redirect Router

Only `redirect: ...` enters this router. Plain `approve` and `done` skip it.

### Step 0: Classify Scope

- At the initial plan-checkpoint, the redirect targets the upfront slice plan. Set `affected_slice = 1`.
- At a use-checkpoint after slice N, the redirect can target slice N, upcoming slices, or slice ordering.
- Set `affected_slice` to the lowest slice touched. If ambiguous, ask one targeted question.

### Step 1: Apply Spec Amendment

Append a timestamped section to `.tenet/runs/{run_slug}/spec.md`:

```markdown
## Redirect at slice {N} ({ISO timestamp})

User feedback: {redirect text}

Affected slice(s): {N} onwards
```

If the redirect changes order/adds/removes slices, update `## Slice plan` in place too. Keep the amendment as the audit trail.

### Step 2: Classify Design Impact

| Redirect content | Mockup re-fire? |
|---|---|
| Pure visual tweak (color, copy, layout) | Yes — UI delta only |
| New external service / schema shift / structural change | Yes — UI + architecture delta |
| Pure reorder of slice plan, no design change | No |
| Adding a new slice | Yes — new wireframe + architecture delta if structural |
| Pure spec content change | No |

Cache the decision for Step 5.

### Step 3: Re-Validate Readiness

Call `tenet_validate_readiness(feature="{feature}")`. Wait via `tenet_job_wait` + `tenet_job_result`.

### Step 4: Resolve Blockers

For each blocker, route by readiness category:

| Category | Resolution |
|---|---|
| `spec_sufficiency` | Amend spec with missing behavior, error policy, or edge case. |
| `research_prior_art` | Research, write knowledge, then amend spec. |
| `interface_contracts` | Pin API/event/DB contracts in spec; update architecture mockup if external. |
| `external_service_access` | Amend harness and ask user for required values. Do not guess credentials. |
| `env_runtime` | Amend harness with env vars, start command, port, health check. |
| `test_data_fixtures` | Amend harness and ask for unsynthesizable fixtures. |
| `test_strategy` | Amend spec with unit/integration/e2e strategy and mocked/skipped reasons. |
| `deps_tooling` | Amend harness with library/runtime versions and build/test commands. |

If user-facing intent is unclear, run a mini interview with one targeted question, append the answer to the interview transcript, then re-run readiness.

Cap the readiness loop at 5 iterations. If still blocked:

1. Halt the router.
2. Brief the user with remaining blockers and what was tried.
3. Ask the user to rephrase the redirect or cancel it.
4. If cancelled, remove the redirect amendment and slice-plan edits, then resume at the originating checkpoint.

### Step 5: Re-Fire Mockup If Needed

If Step 2 says mockup re-fire is needed, run `phases/03-visuals.md` section 5.2. Produce targeted deltas only, then run readiness once more.

### Step 6: Re-Enter Build

Once readiness passes:

1. Cancel pending/in-flight jobs for the affected slice and downstream slices via `tenet_cancel_job`.
2. Do not cancel already-completed earlier slices.
3. Re-fire decomposition for `affected_slice` per `phases/04-decomposition.md` section 9.
4. Append a new `## Slice {N} (revision {K})` section to decomposition.
5. Register the new slice jobs with `tenet_register_jobs`.
6. Return to the slice loop.

## 6. Invariants

- The checkpoint is blocking. Silence is not consent.
- Every redirect is timestamped and slice-tagged.
- Readiness must pass after every redirect before building resumes.
- Per-job eval still runs on every job in every slice.
- User `approve`, `redirect`, and `done` responses always outrank agent preferences.
