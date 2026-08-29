import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      // Ratchet the audited baseline. New tests in focused PRs should raise these values.
      thresholds: { statements: 53, branches: 40, functions: 55, lines: 61 },
    },
  },
});
