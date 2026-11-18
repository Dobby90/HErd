import { createServer } from 'vite';

const apiModules = await createServer({ configFile: 'vite.api.config.ts', server: { middlewareMode: true, hmr: false } });
let web;
let api;
let closing;

function close() {
  closing ??= Promise.allSettled([api?.close(), web?.close(), apiModules.close()]).then(results => {
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(result.reason);
        process.exitCode = 1;
      }
    }
  });
  return closing;
}

try {
  const { createApi } = await apiModules.ssrLoadModule('/apps/api/src/app.ts');
  ({ api } = createApi());
  const address = await api.listen({ host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) });
  web = await createServer();
  await web.listen();
  console.log(address);
  web.printUrls();
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await close();
}
