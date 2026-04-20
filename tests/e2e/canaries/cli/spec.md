# Spec — `key-count` CLI

## Summary

Build a tiny TypeScript CLI that prints the number of top-level keys in a JSON file.

## Acceptance Criteria

- **Entry point**: `src/key-count.ts`, compiles to `dist/key-count.js`.
- **Usage**: `node dist/key-count.js <path-to-json-file>`.
- **Happy path**: reads the file, parses as JSON, prints exactly `N keys in <path>` where `N` is the count of top-level keys (for objects) or array elements (for top-level arrays).
- **Missing file**: prints `error: file not found: <path>` to stderr, exits with code 1.
- **Invalid JSON**: prints `error: invalid JSON in <path>` to stderr, exits with code 1.
- **Empty object `{}`**: prints `0 keys in <path>`.
- **Top-level non-object/non-array** (e.g., `"hello"` or `42`): prints `error: top-level must be object or array in <path>` to stderr, exits with code 1.

## Non-goals

- No nested key counting.
- No schema validation.
- No streaming or large-file optimization.
- No config file, no flags.

## Example

```
$ cat sample.json
{"name": "tenet", "version": "1.0", "license": "MIT"}
$ node dist/key-count.js sample.json
3 keys in sample.json
```

## Tests

At minimum, behavioral tests in `tests/key-count.test.ts` covering:
1. object with multiple keys
2. empty object
3. array with elements
4. missing file
5. invalid JSON
6. non-object/array top-level
