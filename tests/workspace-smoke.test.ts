import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { build } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config.js';

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

it('starts both development servers, proxies API requests and shuts down', async () => {
  expect(config.server?.proxy?.['/api']).toBeDefined();
  const apiPort = await freePort();
  const webPort = await freePort();
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    env: { ...process.env, API_PORT: String(apiPort), WEB_PORT: String(webPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = once(child, 'exit');
  const url = 'http://127.0.0.1:' + webPort;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok) {
        expect(await response.json()).toEqual({ status: 'ok' });
        expect((await fetch(url)).ok).toBe(true);
        return;
      }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Development servers did not become ready\n' + logs);
  } finally {
    child.kill('SIGTERM');
    await exited;
    await expect(fetch(url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    await expect(fetch('http://127.0.0.1:' + apiPort, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  }
}, 20_000);

it('builds the browser with UI metadata and no server parser in its module graph', async () => {
  const modules: string[] = [];
  await build({ logLevel: 'silent', build: { write: false }, plugins: [{
    name: 'inspect-browser-modules',
    generateBundle() { modules.push(...this.getModuleIds()); },
  }] });
  expect(modules.some(id => id.includes('dialect-postgresql/src/ui.ts'))).toBe(true);
  expect(modules.filter(id => /pgsql-parser|libpg-query|dialect-postgresql\/src\/(?:server|parser)/.test(id))).toEqual([]);
  for (const name of ['model', 'sql-contract', 'sql-service']) {
    const manifest = JSON.parse(await readFile('packages/' + name + '/package.json', 'utf8'));
    expect(Object.keys(manifest.dependencies).filter(dep => /postgresql|pg-query|pgsql-parser/.test(dep))).toEqual([]);
  }
});
