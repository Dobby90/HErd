import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: 'build/cache/vitest',
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', testTimeout: 20_000, include: ['tests/**/*.test.{ts,tsx}'],
        exclude: ['tests/**/*.integration.test.ts', 'tests/**/*.release.test.ts'] } },
      { extends: true, test: { name: 'postgresql', include: ['tests/**/*.integration.test.ts'], testTimeout: 60_000 } },
      { extends: true, test: { name: 'release', include: ['tests/**/*.release.test.ts'], testTimeout: 120_000, fileParallelism: false } },
    ],
  },
});
