import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'apps/web'),
  envDir: import.meta.dirname,
  cacheDir: resolve(import.meta.dirname, 'build/cache/erd-web'),
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:' + Number(process.env.API_PORT ?? 3001) },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true,
    rollupOptions: { output: { manualChunks: id => id.includes('/node_modules/') ? 'vendor' : undefined } },
  },
});
