import { execFileSync, spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { freePort } from './tcp.js';

export function migrateBuilt(databaseUrl: string) {
  return execFileSync(process.execPath, ['dist/api/migrate.js'], {
    env: { DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 15_000,
  });
}

export async function builtApi(databaseUrl: string, applicationOrigin: string, settings: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const processHandle = spawn(process.execPath, ['dist/api/main.js'], {
    env: {
      DATABASE_URL: databaseUrl, APP_ORIGIN: applicationOrigin, API_PORT: String(port),
      NODE_ENV: 'test', ERD_DEV_LOGIN: '1', ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (part: Buffer) => { output = (output + part.toString('utf8')).slice(-96_000); };
  processHandle.stdout.on('data', append);
  processHandle.stderr.on('data', append);
  const stopped = new Promise<void>(resolve => {
    processHandle.once('exit', () => resolve());
    processHandle.once('error', () => resolve());
  });
  async function close() {
    if (processHandle.exitCode !== null || processHandle.signalCode) return;
    processHandle.kill('SIGTERM');
    const deadline = AbortSignal.timeout(5000);
    const force = () => processHandle.kill('SIGKILL');
    deadline.addEventListener('abort', force, { once: true });
    await stopped;
    deadline.removeEventListener('abort', force);
  }

  async function request(path: string, init?: RequestInit) {
    return fetch(base + path, { signal: AbortSignal.timeout(25_000), ...init });
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) break;
    if (await request('/api/health', { signal: AbortSignal.timeout(150) }).then(response => response.ok, () => false)) {
      return { port, request, close, logs: () => output, pid: processHandle.pid! };
    }
    await setTimeout(50);
  }
  await close();
  throw new Error('Start the compiled API with pnpm build before pnpm test:release.' + '\n' + output);
}
