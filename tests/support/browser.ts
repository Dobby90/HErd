import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import { createServer, preview } from 'vite';
import { freePort } from './tcp.js';

export async function withBrowser(run: (context: BrowserContext, origin: string) => Promise<void>,
  ports?: { web: number; api: number; production?: boolean }) {
  const output = resolve('build/erd-browser');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(resolve(output, 'run-'));
  const temp = resolve(directory, 'tmp');
  await mkdir(temp);
  // Chromium's Linux singleton socket has a Unix path length limit. The proc path
  // resolves to the same writable directory even under a long worktree mount.
  const chromiumTemp = process.platform === 'linux'
    ? '/proc/' + process.pid + '/cwd/' + relative(process.cwd(), temp)
    : temp;
  let context: BrowserContext | undefined;
  let server: Awaited<ReturnType<typeof createServer | typeof preview>> | undefined;
  let failed = true;
  try {
    const config = { configFile: resolve('vite.config.ts'), cacheDir: resolve(directory, 'vite'), logLevel: 'silent' as const };
    const network = { host: '127.0.0.1', port: ports?.web ?? await freePort(), strictPort: true,
      ...(ports && { proxy: { '/api': 'http://127.0.0.1:' + ports.api } }) };
    if (ports?.production) server = await preview({ ...config, preview: network });
    else {
      const dev = await createServer({ ...config, server: { ...network, hmr: false, watch: null, ws: false } });
      server = dev;
      await dev.listen();
    }
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not open a loopback port.');
    const origin = 'http://127.0.0.1:' + address.port;
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
      baseURL: origin,
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      env: { ...process.env, TMPDIR: chromiumTemp },
      args: ['--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 850 },
    });
    await run(context, origin);
    failed = false;
  } finally {
    try {
      if (context) {
        try {
          if (failed) await Promise.allSettled(context.pages().map((page, index) =>
            page.screenshot({ path: resolve(directory, `failure-${index}.png`), timeout: 3_000 })));
        } finally {
          await context.close();
        }
      }
    } finally {
      try {
        await server?.close();
      } finally {
        if (!failed) await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
