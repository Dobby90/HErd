import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.api.config.ts',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
try {
  await server.ssrLoadModule('/apps/api/src/sql-worker.ts');
} finally {
  await server.close();
}
