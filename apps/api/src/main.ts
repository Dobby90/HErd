import { createApi } from './app.js';

const { api } = createApi();

async function shutdown() {
  try {
    await api.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

try {
  const address = await api.listen({ host: '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) });
  console.log(address);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await shutdown();
}
