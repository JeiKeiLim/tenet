# Harness — click-counter

## Formatting & Linting

- formatter: prettier defaults
- linter: none

## Runtime

- Node >= 20 (only for the test runner)
- Vitest + jsdom for the behavioral test

## Build & Test

- `npm install` / `pnpm install`
- No TypeScript build required (HTML is shipped as-is).
- `npx vitest run` to exercise the test.

## File Layout (expected)

```
index.html               # the page
tests/click-counter.test.ts
package.json
```

## Danger Zones

- Do not modify `.tenet/`.
- Do not add a build system (webpack/vite/etc.) — the page must be runnable as-is in a browser.

## Iron Laws

- No external assets beyond what the spec explicitly requires.
- No `<script src="https://...">` — inline scripts only.
- The acceptance test must mount `index.html` into jsdom and click the button.

## Architecture Rules

- Single HTML file. Inline CSS and JS are both fine.
- JS must be ≤ 30 lines.

## Test Strategy

- **Unit** (`ready`): jsdom test covering button click + counter update.
- **Integration/e2e**: `not_applicable` for this canary.
- **Shared state**: none (pure static file, fresh jsdom per test). eval_parallel_safe is expected to be true.
