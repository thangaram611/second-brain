import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // 24 supertest/Express suites run as parallel forks, and under a full
      // `pnpm test` they also compete with every other package. Async requests
      // that finish in milliseconds in isolation can occasionally blow past
      // Vitest's 5s default purely from event-loop starvation under that load.
      // Raise the ceiling so transient contention can't flake the suite; a
      // genuinely-hung request still fails, just later.
      testTimeout: 15_000,
    },
  }),
);
