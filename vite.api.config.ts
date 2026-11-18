import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: 'build/cache/erd-api',
  ssr: { noExternal: [/^@erd\//], external: ['pgsql-parser'] },
  build: {
    ssr: true, outDir: 'dist/api', target: 'node24',
    rollupOptions: { input: { main: 'apps/api/src/main.ts', 'sql-worker': 'apps/api/src/sql-worker.ts' } },
  },
});
