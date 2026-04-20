# Harness — key-count CLI

## Formatting & Linting

- formatter: prettier defaults (do not add a config file)
- linter: none required for this canary

## Runtime

- Node >= 20
- TypeScript (`typescript` as devDep)
- Vitest (`vitest` as devDep) for unit tests

## Build & Test

- `npm install` (pnpm also acceptable) installs devDeps.
- `npx tsc` compiles src/ → dist/
- `npx vitest run` runs tests/*.test.ts

## File Layout (expected)

```
src/key-count.ts
tests/key-count.test.ts
tsconfig.json        # NodeNext or ESNext module; target ES2022
package.json         # with "type": "module"
```

## Danger Zones

- Do not modify `.tenet/` contents yourself — those are orchestrator artifacts.

## Iron Laws

- No network calls.
- No writes outside the CLI's declared behavior (stdout/stderr only; no writing to disk besides standard `tsc` build output).
- Every acceptance criterion must have a test.

## Architecture Rules

- Single file under `src/`. No over-modularization — this is a 50-line tool.
- Use `fs.readFileSync` + `JSON.parse`. No dependencies beyond the standard library.
