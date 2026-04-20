import path from 'node:path';
import { runCanary } from './harness.js';

const canaryDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'canaries', 'api');

// Exercises the stateful-app path: readiness should mark eval_parallel_safe=false
// and critics should run sequentially. Budget: ~10-15 min, ~$0.08-0.25 on Haiku,
// ~$0.50-1.20 on Sonnet. Invoke via `make e2e-api`.
describe('E2E canary: note-store API', () => {
  it('builds a working in-memory notes API from spec+harness', async () => {
    const result = await runCanary({
      feature: 'note-store',
      name: 'api',
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
