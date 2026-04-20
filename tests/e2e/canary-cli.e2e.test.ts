import path from 'node:path';
import { runCanary } from './harness.js';

const canaryDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'canaries', 'cli');

// Runs a real agent end-to-end. Budget: ~5-10 minutes, ~$0.05-0.15 on Haiku,
// ~$0.30-0.80 on Sonnet. Invoke via `make e2e-cli`.
describe('E2E canary: key-count CLI', () => {
  it('builds a working CLI from spec+harness', async () => {
    const result = await runCanary({
      feature: 'key-count',
      name: 'cli',
      canaryDir,
    });

    if (!result.passed) {
      // Print full failure context — this is a manual-only test; noisy output is fine.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.cycles).toBeGreaterThan(0);
  });
});
