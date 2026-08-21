import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    sequence: { concurrent: false },
    coverage: { reporter: ['text', 'html'] },
  },
});
