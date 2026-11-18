import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', testTimeout: 20_000, include: ['tests/**/*.test.{ts,tsx}'], exclude: ['tests/**/*.integration.test.ts'] } },
      { extends: true, test: { name: 'postgresql', include: ['tests/**/*.integration.test.ts'], testTimeout: 60_000 } },
    ],
  },
});
