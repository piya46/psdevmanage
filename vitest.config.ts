import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,mjs}', 'tests/integration/**/*.test.{ts,mjs}'],
    fileParallelism: false,
    testTimeout: 45000,
    hookTimeout: 45000,
  },
});
