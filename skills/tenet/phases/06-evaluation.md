# Phase 6: Evaluation

The evaluation pipeline ensures that all implemented work meets both mechanical requirements and the original intent. It enforces a strict separation between the author and the critic to prevent leniency.

## The 5 Evaluation Stages

### Stage 1: Mechanical
Automated checks with no human judgment. Run these commands and verify exit codes:
- **Lint**: Run the project linter from harness config.
- **Build**: Execute the build command.
- **Type-check**: Verify types across the changed files.
- **Tests**: Run the full test suite.
**PASS**: All exit 0. **FAIL**: Any non-zero exit code.

### Stage 1.5: Property-based
If the harness or spec defines property tests, run them now. These properties must predate the implementation. Skip if no property tests exist.

### Stage 2: Spec Compliance (Author Context)
The agent that performed the work performs this check:
- Are all acceptance criteria from the spec met?
- Are all deliverables from the decomposition present?
- Does the code match the documented design?
**Output**: A checklist with pass/fail status per criterion.

### Stage 3: Purpose Alignment (Critic Context)
A separate agent session with no prior implementation history performs this review. It receives the spec, scenarios, harness, and the diff, but never the author's reasoning or prior conversation.

The critic checks:
- Does the implementation match the spec's intent?
- Are any anti-scenarios violated?
- Are there obvious gaps or missing edge cases?

**Zero-findings rule**: If the critic finds nothing, it must re-analyze using an alternate attack vector like security, performance, or concurrency. Zero findings trigger a mandatory second pass.

### Stage 4: Structured Self-Questioning
The critic asks and answers these specific questions:
- **Edge cases**: Empty input? Max values? Unicode?
- **Error paths**: Dependency failures? Timeouts? Disk full?
- **Integration**: Does this break upstream or downstream components?
- **UX**: Is behavior consistent? Are error messages helpful?
- **Security**: Input validation? Secret exposure? Injection?
- **Performance**: N+1 queries? Unbounded loops? Memory leaks?

## Evaluation Result Format
Record results via `tenet_update_knowledge` with a descriptive title. Example: `title="eval project-scaffold mechanical-and-spec-compliance"`. The tool generates a dated markdown file in `.tenet/knowledge/`.

```markdown
# Evaluation: job-{id}

## Stage 1: Mechanical
- lint: PASS/FAIL
- build: PASS/FAIL
- typecheck: PASS/FAIL
- tests: PASS/FAIL (N/M passed)

## Stage 2: Spec Compliance
- [x] Criterion 1
- [ ] Criterion 2 — FAIL: reason

## Stage 3: Purpose Alignment (Critic)
- Finding 1: Description
- Zero-findings recheck: [done/not-needed]

## Stage 4: Self-Questioning
- Edge case concern: [description] → [action: fix/defer/accept]

## Overall: PASS / FAIL
```

## Handling Failures
- **Stage 1 Fail**: Fix the mechanical issue immediately.
- **Stage 2/3/4 Fail**: Run reflection to find the root cause, then retry via `tenet_continue`.
- **Limits**: Max 3 retries per job before marking it as blocked.

## Anti-Skip Enforcement
Evaluation is mandatory. Every job must pass Stage 1 and 2. Full mode requires Stage 3 and 4. The author cannot be the sole evaluator. Stage 3 requires a fresh, separate context.
