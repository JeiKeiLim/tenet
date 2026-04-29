---
delivery_mode: agile
---

# Spec — `key-count` CLI (agile, 2 slices)

## Summary

Build a tiny TypeScript CLI that prints the number of top-level keys in a JSON file. Delivered in two slices: a basic version first (slice 1), then a `--pretty` flag for nicer output (slice 2). Slicing is additive — slice 2 contains everything from slice 1 plus the new flag.

## Tech stack

- Node >= 20, TypeScript, Vitest. Standard library only — no runtime dependencies.

## Acceptance criteria (final state, slice 2)

- **Entry point**: `src/key-count.ts`, compiles to `dist/key-count.js`.
- **Usage**: `node dist/key-count.js [--pretty] <path-to-json-file>`.
- **Happy path**: reads the file, parses as JSON, prints exactly `N keys in <path>` where `N` is the count of top-level keys (objects) or array elements (top-level arrays).
- **Pretty mode** (`--pretty`): same count, but output formatted as `<path>: N keys` with a leading "✓ " marker.
- **Missing file**: prints `error: file not found: <path>` to stderr, exits with code 1.
- **Invalid JSON**: prints `error: invalid JSON in <path>` to stderr, exits with code 1.
- **Empty object `{}`**: prints `0 keys in <path>` (or pretty equivalent).
- **Top-level non-object/non-array**: prints `error: top-level must be object or array in <path>` to stderr, exits with code 1.

## Slice plan

Total slices: 2

### Slice 1: basic key-count
- **Adds**: counting top-level keys in JSON files via CLI.
- **Bundled with**: error handling for missing file, invalid JSON, and non-object/array top-levels.
- **User can**: run `node dist/key-count.js sample.json` and see `N keys in sample.json`.
- **Out of slice**: `--pretty` flag (slice 2).

### Slice 2: pretty output flag
- **Adds**: `--pretty` flag that switches output format to `✓ <path>: N keys`.
- **Bundled with**: argv parsing for the optional flag (any position before the path).
- **User can**: run `node dist/key-count.js --pretty sample.json` and see `✓ sample.json: N keys`.
- **Out of slice**: nothing — this is the final slice.

## Non-goals

- No nested key counting.
- No schema validation.
- No streaming or large-file optimization.
- No config file, no flags beyond `--pretty`.

## Tests

Behavioral tests in `tests/key-count.test.ts` covering, after slice 2 ships:
1. object with multiple keys (default output)
2. empty object (default output)
3. array with elements (default output)
4. missing file
5. invalid JSON
6. non-object/array top-level
7. `--pretty` flag with object
8. `--pretty` flag with array
