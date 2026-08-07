import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRubricJson } from './rubric.js';

// ─── Production-shape golden test ───────────────────────────────────────────
// Critic outputs shaped like real production data (prose + verdict, fenced,
// tool echoes, truncated, unmatched-quote-in-prose, raw NDJSON), with the
// ground-truth verdict for each. This is the regression baseline for the
// parser: it ensures any refactor behaves the same on realistic shapes, not
// just on synthetic fixtures. The expected verdicts were established with a
// simple rightmost-object walk (walk { from the end, parse to its matching },
// keep the first object with a boolean `passed` key, preferring a `stage` key).
//
// case-07 pins the unmatched-quote shape: prose before the verdict contains
// an unmatched double quote that a string-state walk would misread as opening
// a string, false-rejecting a valid verdict. The rightmost-walk handles it.

type GoldenCase = {
  id: string;
  type: string;
  output: string;
  expected: { passed: boolean; stage: string } | null;
};

const fixtures: GoldenCase[] = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'fake-agents', 'production-critic-outputs.json'),
    'utf8',
  ),
);

describe('extractRubricJson on production critic outputs', () => {
  it.each(fixtures.map((f) => [f.id, f] as const))('%s — matches the ground-truth verdict', (_id, f) => {
    const got = extractRubricJson(f.output);
    const expected = f.expected;
    if (expected === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got).not.toBeNull();
    expect(got?.passed).toBe(expected.passed);
    expect(got?.stage).toBe(expected.stage);
  });
});
