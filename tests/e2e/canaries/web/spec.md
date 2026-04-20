# Spec — Static `click-counter` page

## Summary

Build a single static HTML page with one button that increments a visible counter on click. Zero dependencies, zero build step required.

## Acceptance Criteria

- **File**: `index.html` at repository root.
- **Markup**:
  - A heading with text `Click Counter`.
  - A `<button>` element with id `increment-btn` and visible text `Click me`.
  - A `<span>` element with id `count-display` that starts at `0`.
- **Behavior**:
  - Clicking `#increment-btn` increments the number in `#count-display`.
  - Counter resets on page reload (no persistence).
- **Styling**:
  - Minimal inline CSS is fine.
  - Button should have at least 10px padding.

## Non-goals

- No build step, no bundler.
- No external scripts (no CDN, no npm).
- No persistence (localStorage, etc.).
- No tests file — the canary verifies via DOM parsing of `index.html`.

## Tests

Write one behavioral test in `tests/click-counter.test.ts` using `jsdom` (add as devDep) that:
1. Loads `index.html` into a jsdom window.
2. Confirms the three elements (h1/button/span) exist with the required attributes.
3. Simulates a click on `#increment-btn` and asserts `#count-display` changes from `0` to `1`.
