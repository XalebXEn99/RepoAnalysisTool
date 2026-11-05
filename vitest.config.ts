import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    // ingest touches the real git binary and a scratch database
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
