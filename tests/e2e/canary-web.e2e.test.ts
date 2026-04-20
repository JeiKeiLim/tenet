import path from 'node:path';
import { runCanary } from './harness.js';

const canaryDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'canaries', 'web');

// Exercises the stateless-static path. Readiness should mark eval_parallel_safe=true.
// Budget: ~8-12 min, ~$0.07-0.20 on Haiku, ~$0.40-1.00 on Sonnet.
// Invoke via `make e2e-web`.
describe('E2E canary: click-counter static page', () => {
  it('builds a working static click-counter from spec+harness', async () => {
    const result = await runCanary({
      feature: 'click-counter',
      name: 'web',
      canaryDir,
    });

    if (!result.passed) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.cycles).toBeGreaterThan(0);
  });
});
