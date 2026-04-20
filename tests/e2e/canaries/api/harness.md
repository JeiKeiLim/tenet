# Harness — note-store API

## Formatting & Linting

- formatter: prettier defaults
- linter: none required

## Runtime

- Node >= 20
- TypeScript
- Either `express` or the built-in `node:http` module — contributor's choice
- `vitest` for tests

## Build & Test

- `npm install` / `pnpm install`
- `npx tsc` for build
- `npx vitest run` for tests

## File Layout (expected)

```
src/server.ts        # exports createServer(): http.Server
src/index.ts         # entrypoint: starts listening on PORT
tests/server.test.ts # behavioral tests
tsconfig.json
package.json
```

## Danger Zones

- Do not modify `.tenet/`.
- Do not introduce persistent storage (the canary is explicitly in-memory).

## Iron Laws

- Server must bind to `process.env.PORT || 3000` and release the port cleanly on SIGTERM.
- Tests must NOT assume a specific port — they boot their own instance on an ephemeral port (listen on `0`).
- No network calls other than to the server under test.
- Every acceptance criterion has a behavioral test that verifies the observable response.

## Architecture Rules

- Pure in-memory Map; no database.
- Keep code in `src/`; split only if it improves readability (≤200 lines total is fine as a single file).

## Test Strategy

- **Unit/integration** (`live` / `ready`): ran with a fresh ephemeral server per test.
- **e2e**: `not_applicable` (no UI).
- **Shared mutable state** across tests: YES — parallel critics would collide on the Map and the port. Expect eval_parallel_safe=false.
