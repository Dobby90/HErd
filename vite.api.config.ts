import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: 'node_modules/.cache/erd-api',
  ssr: { noExternal: [/^@erd\//] },
  build: { ssr: 'apps/api/src/main.ts', outDir: 'dist/api', target: 'node24' },
});
