import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    // File-watcher and git tests use real filesystem events, which can exceed
    // Vitest's 5s default when Turbo runs the whole workspace concurrently.
    testTimeout: 15_000,
  },
}));
