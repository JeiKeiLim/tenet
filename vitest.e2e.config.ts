import { defineConfig } from 'vitest/config';

// E2E config — runs canary scenarios against real agent CLIs.
// Not included in the default `pnpm test` run. Invoke via:
//   pnpm vitest run --config vitest.e2e.config.ts
// or one of the `make e2e-*` targets.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.test.ts'],
    // Canary runs involve real agent calls (minutes each) + final smoke checks.
    // One test = one full Tenet cycle; wait out the longest plausible completion.
    testTimeout: 30 * 60 * 1000, // 30 minutes
    hookTimeout: 60 * 1000,
    // Vitest parallelism would race multiple real agents against shared rate limits.
    // Run one canary at a time.
    fileParallelism: false,
    pool: 'forks',
    // In Vitest 4, pool-specific options moved to top-level.
    // `fileParallelism: false` already serializes file execution, which is what we want.
  },
});
