import path from 'node:path';
import { runCanary } from './harness.js';

const canaryDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'canaries', 'agile-cli');

// Runs a real agent end-to-end through TWO slices of an agile-mode build.
// Budget: ~10-15 minutes, ~$0.10-0.30 on Haiku, ~$0.60-1.50 on Sonnet.
// Invoke via `make e2e-agile`.
//
// What this exercises that the autonomous canaries don't:
// - delivery_mode: agile front matter on the spec
// - Two sequential tenet_register_jobs calls (one per slice)
// - status.md surfacing "Slice N of M in progress" lines (AC16/AC17)
// - additive slicing (slice 2 builds on slice 1's deliverables)
//
// What this does NOT exercise (still requires manual user-driven runs):
// - Plan-checkpoint and use-checkpoint pause behavior (the harness IS the
//   orchestrator and auto-approves between slices)
// - Redirect router (no redirects in the canary)
// - Crystallization phase prompts (interview/spec/mockup are pre-seeded)
describe('E2E canary: agile-cli (key-count, 2 slices)', () => {
  it('builds slice 1 then slice 2 and produces a working --pretty CLI', async () => {
    const result = await runCanary({
      feature: 'key-count',
      name: 'agile-cli',
      canaryDir,
      slices: 2,
    });

    if (!result.passed) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.cycles).toBeGreaterThanOrEqual(2); // at least one cycle per slice
  });
});
