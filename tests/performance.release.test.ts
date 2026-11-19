import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import type { GenerateSqlJob, ParseSqlJob } from '@erd/sql-contract';
import { expect, it } from 'vitest';
import { scaleDocument } from '../packages/test-fixtures/src/scale.js';
import { withBrowser } from './support/browser.js';
import { openExport } from './support/editor-ui.js';
import { builtApi, migrateBuilt } from './support/built-api.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

const mib = (bytes: number) => Math.round(bytes / (1024 * 1024) * 10) / 10;
const elapsed = (start: number) => Math.round(performance.now() - start);

it('measures both release models through the built browser, API and PostgreSQL', async () => {
  await withPostgres(async cluster => {
    migrateBuilt(cluster.connectionString);
    const web = await freePort();
    const origin = 'http://127.0.0.1:' + web;
    const api = await builtApi(cluster.connectionString, origin);
    async function rssMiB() {
      const status = await readFile('/proc/' + api.pid + '/status', 'utf8').catch(() => '');
      const kib = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
      return Number.isFinite(kib) ? mib(kib * 1024) : undefined;
    }
    const results: unknown[] = [];
    try {
      await withBrowser(async context => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(12_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const heading = (name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.goto(origin + '/?workspace=1');
        await button('개발 계정으로 로그인').click();
        await button('새 프로젝트').click();
        await page.getByLabel('새 프로젝트 이름').fill('릴리스 성능');
        await button('프로젝트 생성').click();
        await heading('릴리스 성능');
        const user = await page.request.get('/api/me').then(response => response.json());
        const headers = { origin, 'x-csrf-token': user.csrfToken };
        const project = '/api/projects/' + new URL(page.url()).searchParams.get('project')!;

        for (const [tables, fks, openBudget] of [[100, 150, 3000], [300, 600, 8000]]) {
          const id = '00000000-0000-4000-8000-' + String(tables).padStart(12, '0');
          const document = scaleDocument(id, tables, fks);
          const apiPath = '/api/erds/' + id;
          const editor = origin + '/?workspace=1&project=' + project.split('/').at(-1) + '&erd=' + id;
          expect((await page.request.post(project + '/erds', { headers, data: { document } })).status()).toBe(201);
          const node = (index: number) => page.locator('.react-flow__node[data-id="overview-placement-' + index + '"]');
          const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const opens: number[] = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            const started = performance.now();
            await page.goto(editor);
            await heading(document.name);
            await node(0).waitFor();
            await expect.poll(() => node(0).evaluate(element => getComputedStyle(element).visibility), { timeout: 5000 }).toBe('visible');
            await paint();
            opens.push(elapsed(started));
          }
          expect(Math.max(...opens)).toBeLessThan(openBudget);
          const domNodes = await page.locator('.react-flow__node').count();
          if (tables === 300) {
            expect(domNodes).toBeLessThan(60);
            expect(await node(tables - 1).count()).toBe(0);
          }
          const browserHeap = await session.send('Runtime.getHeapUsage');
          const apiAfterOpen = await rssMiB();

          const search = performance.now();
          await page.getByLabel('스키마 및 다이어그램 검색').fill('최종 배송 찾기');
          await button('최종 배송 찾기').click();
          const highlighted = node(tables - 1).locator('.canvas-column.search-match');
          await highlighted.waitFor();
          await paint();
          const searchMs = elapsed(search);
          const inspector = page.getByRole('complementary', { name: '속성' });
          await inspector.getByLabel('물리명', { exact: true }).fill('revised_attribute');
          const editStarted = performance.now();
          let sent = 0;
          const observePut = (request: { method(): string; url(): string }) => {
            if (request.method() === 'PUT' && request.url().endsWith(apiPath)) sent = performance.now();
          };
          page.on('request', observePut);
          const saving = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(apiPath));
          await button('컬럼 적용').click();
          await highlighted.getByText('revised_attribute', { exact: true }).waitFor();
          const editMs = elapsed(editStarted);
          const saved = await saving;
          expect(saved.ok()).toBe(true);
          expect(sent).toBeGreaterThan(0);
          const saveRttMs = elapsed(sent);
          page.off('request', observePut);
          await page.getByText('서버 저장됨 · 리비전 2', { exact: true }).waitFor();
          const saveWithDebounceMs = elapsed(editStarted);
          if (tables === 100) expect(saveWithDebounceMs).toBeLessThan(2000);

          const last = node(tables - 1);
          const hover = last.locator('article > strong');
          const beforeMove = await last.evaluate(element => (element as HTMLElement).style.transform);
          const box = (await hover.boundingBox())!;
          const drag = performance.now();
          await page.mouse.move(box.x + Math.min(30, box.width / 2), box.y + Math.min(15, box.height / 2));
          await page.mouse.down();
          await page.mouse.move(box.x + 78, box.y + 49, { steps: 6 });
          await page.mouse.up();
          await expect.poll(() => last.evaluate(element => (element as HTMLElement).style.transform), { timeout: 4000 }).not.toBe(beforeMove);
          const dragMs = elapsed(drag);
          await page.getByText('서버 저장됨 · 리비전 3', { exact: true }).waitFor();
          const apiAfterSave = await rssMiB();

          const submit = (data: object) => page.request.post(project + '/sql/jobs', {
            headers, data: { ...data, mutationId: randomUUID() },
          });
          async function waitJob<T extends GenerateSqlJob | ParseSqlJob>(id: string): Promise<T> {
            let job: T;
            await expect.poll(async () => {
              job = await page.request.get('/api/sql/jobs/' + id).then(response => response.json());
              return job.state;
            }, { timeout: 11_000, interval: 30 }).toMatch(/succeeded|failed/);
            return job!;
          }
          const generation = performance.now();
          const created = await submit({ kind: 'generate', erdId: id, revision: 3 });
          expect(created.status()).toBe(202);
          const reads = await Promise.all(['/api/health', apiPath].map(async path => {
            const start = performance.now();
            const response = await page.request.get(path);
            expect(response.ok()).toBe(true);
            await response.json();
            return elapsed(start);
          }));
          const generated = await waitJob<GenerateSqlJob>((await created.json()).id);
          const exportMs = elapsed(generation);
          expect(generated.state, JSON.stringify(generated.output?.diagnostics)).toBe('succeeded');
          const sql = generated.output!.sql!;
          const apiAfterExport = await rssMiB();
          expect(sql).toContain('"revised_attribute"');
          const parsing = performance.now();
          const submitted = await submit({ kind: 'parse', sql, defaultNamespace: 'public', target: document.target });
          expect(submitted.status()).toBe(202);
          const parsed = await waitJob<ParseSqlJob>((await submitted.json()).id);
          const parseMs = elapsed(parsing);
          expect(parsed.state, JSON.stringify(parsed.output?.diagnostics)).toBe('succeeded');
          expect(parsed.output?.catalog?.tables).toHaveLength(tables);
          expect(parsed.output?.catalog?.constraints.filter(key => key.kind === 'fk')).toHaveLength(fks);
          const apiAfterParse = await rssMiB();
          if (apiAfterParse !== undefined) expect(apiAfterParse).toBeLessThan(768);

          let pngPreviewMs: number | undefined;
          if (tables === 100) {
            await page.getByLabel('스키마 및 다이어그램 검색').fill('');
            await button('창고 상세').click();
            await openExport(page, '이미지');
            const start = performance.now();
            await button('출력 미리보기').click();
            await page.getByRole('img', { name: 'ERD 이미지 출력 미리보기' }).waitFor();
            await button('PNG 다운로드').waitFor();
            pngPreviewMs = elapsed(start);
            await page.getByRole('dialog', { name: '이미지 내보내기' }).getByRole('button', { name: '닫기' }).click();
          }

          results.push({ tables, columns: document.catalog.columns.length, foreignKeys: fks, views: document.views.length,
            jsonBytes: Buffer.byteLength(JSON.stringify(document)), sqlBytes: Buffer.byteLength(sql),
            coldOpensMs: opens, searchMs, dragMs, editMs, saveRttMs, saveWithDebounceMs,
            exportMs, parseMs, healthDuringJobMs: reads[0], readDuringJobMs: reads[1],
            visibleDomNodes: domNodes, browserJsHeapMiB: mib(browserHeap.usedSize),
            apiRssMiB: { afterOpen: apiAfterOpen, afterSave: apiAfterSave, afterExport: apiAfterExport, afterParse: apiAfterParse }, pngPreviewMs });
        }
        const browser = await session.send('Browser.getVersion');
        const platform = await readFile('/etc/os-release', 'utf8').catch(() => '');
        const metrics = {
          browser: browser.product, postgres: cluster.query('SHOW server_version'), node: process.version,
          os: platform.match(/^PRETTY_NAME="([^"]+)"/m)?.[1] ?? process.platform, kernel: release(),
          cpu: cpus()[0]?.model, arch: process.arch, vcpus: availableParallelism(), memoryMiB: mib(totalmem()),
          topology: 'Chromium, production web assets, compiled API and PostgreSQL on container loopback',
          results,
        };
        await mkdir('build/release', { recursive: true });
        await writeFile('build/release/performance.json', JSON.stringify(metrics, null, 2) + '\n');
        console.log(JSON.stringify(metrics));
      }, { web, api: api.port, production: true });
    } finally {
      await api.close();
    }
  });
});
