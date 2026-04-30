Build a tiny TypeScript CLI called `wc-json` that counts words in JSON string values.
Given a JSON file, it recursively scans all string values, counts words (split by whitespace),
and prints the total.

Usage: `node dist/wc-json.js [--verbose] <path-to-json-file>`
- Default output: `N words in <path>`
- `--verbose` output: shows per-key word counts (one per line), then total

Error handling: missing file, invalid JSON.

Deliver in 2 slices:
- Slice 1: basic word count (no --verbose)
- Slice 2: add --verbose flag with per-key breakdown

Use Node >= 20, TypeScript, Vitest. No runtime dependencies.
