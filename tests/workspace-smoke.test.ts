import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { build } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config.js';

import { freePort } from './support/tcp.js';

it('keeps the development and Docker validation toolchain pins aligned', async () => {
  const [packageJson, environmentJson, nodeVersionFile] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('devorchestra.environment.json', 'utf8'),
    readFile('.node-version', 'utf8'),
  ]);
  const manifest = JSON.parse(packageJson);
  const environment = JSON.parse(environmentJson);
  expect(environment.node).toBe(process.versions.node);
  expect(nodeVersionFile.trim()).toBe(environment.node);
  expect(manifest.engines.node).toBe(environment.node);
  expect(environment.pnpm).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.engines.pnpm).toBe(environment.pnpm);
  expect(manifest.packageManager).toBe('pnpm@' + environment.pnpm);
});

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
