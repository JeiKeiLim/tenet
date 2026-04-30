import path from 'node:path';
import { runFullPipelineCanary } from './harness.js';

const canaryDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'canaries',
  'agile-full-pipeline',
);

// Runs a real agent end-to-end through the FULL agile pipeline:
// raw prompt → agent produces spec + decomposition + slicing → build slices → verify.
// Budget: ~20-30 minutes, ~$0.15-0.50 on Haiku, ~$0.50-2.50 on Sonnet.
// Invoke via `make e2e-agile-full`.
//
// What this exercises that the pre-seeded agile canary does not:
// - Agent follows spec phase prompt → produces delivery_mode: agile + Slice plan
// - Agent follows decomposition prompt → produces per-slice job DAGs
// - Agent writes structured job JSON files usable by tenet_register_jobs
// - Each slice is additive and independently eval-passing
//
// What this does NOT exercise (still requires manual user-driven runs):
// - Interactive interview phase (the prompt replaces the interview)
// - Mockup phase (skipped for a CLI canary)
// - Plan-checkpoint / use-checkpoint pause behavior (auto-approves)
// - Redirect router (no redirects in the canary)
describe('E2E canary: agile-full-pipeline (wc-json, agent-driven slicing)', () => {
  it('plans and builds a 2-slice CLI from a raw prompt', async () => {
    const result = await runFullPipelineCanary({
      feature: 'wc-json',
      name: 'agile-full-pipeline',
      canaryDir,
      expectedSlices: 2,
    });

    if (!result.passed) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.specProduced).toBe(true);
    expect(result.decompositionProduced).toBe(true);
    expect(result.actualSlices).toBeGreaterThanOrEqual(2);
    expect(result.cycles).toBeGreaterThanOrEqual(3); // planning + slice 1 + slice 2
  });
});
