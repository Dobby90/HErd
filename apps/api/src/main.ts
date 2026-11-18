import { createApi } from './app.js';

try {
  const { api } = createApi();
  const shutdown = async () => {
    try { await api.close(); }
    catch {
      console.error('API_SHUTDOWN_FAILED');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const address = await api.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) });
    if (process.env.NODE_ENV !== 'production') console.log(address);
  } catch {
    await shutdown();
    throw new Error('API bind failed');
  }
} catch {
  console.error('API_STARTUP_FAILED. Check the API configuration and listening address.');
  process.exitCode = 1;
}
