import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { exportDocument } from '../packages/test-fixtures/src/ddl-export.js';
import { withBrowser } from './support/browser.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

const longName = '배송 일정을 집계하는 국제 물류 운영 품질 검증 테이블 <외부>&';

async function download(page: Page, button: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return readFile(await file.path());
}

it('exports and opens pinned SVG and PNG with off-screen Korean nodes, and rejects unsafe raster dimensions', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const origin = 'http://127.0.0.1:' + web;
    const { api } = createApi({ pool, auth: { origin, devLogin: true } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async context => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(12_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const image = page.getByRole('dialog', { name: '뷰 이미지 내보내기' });
        const preview = image.getByRole('img', { name: 'ERD 이미지 출력 미리보기' });
        const createImage = () => button('출력 미리보기').click();
        await page.goto(origin + '/?workspace=1');
        await button('개발 계정으로 로그인').click();
        await page.getByLabel('새 프로젝트 이름').fill('이미지 검증');
        await button('프로젝트 생성').click();
        await page.getByRole('heading', { name: '이미지 검증' }).waitFor();
        const projectId = new URL(page.url()).searchParams.get('project')!;
        const actor = await page.request.get('/api/me').then(response => response.json());
        const headers = { origin, 'x-csrf-token': actor.csrfToken };
        const document = exportDocument(randomUUID());
        document.name = '배송 데이터 모델';
        document.catalog.tables[0].logicalName = longName;
        document.catalog.tables[1].logicalName = '거래처';
        document.catalog.columns.find(item => item.id === 'b-key')!.logicalName = '고객 참조 키';
        document.views = [
          {
            id: 'main', name: '배송·거래처 관계', nameDisplay: 'logical',
            instances: [
              { id: 'first', tableId: 'a', x: 1430, y: 925, collapsed: true, groupId: 'shipping-group' },
              { id: 'second', tableId: 'b', x: 2310, y: 986, visibleColumnIds: ['b-key'] },
            ],
            groups: [{ id: 'shipping-group', name: '국제 배송 그룹', x: 1390, y: 858, size: { width: 790, height: 348 } }],
            notes: [
              { id: 'test-note', text: '검증 메모 <script> & 기호\n두 번째 줄의 한글', x: 1460, y: 1071, groupId: 'shipping-group' },
              { id: 'free-note', text: '고객 참조 정보를 보존합니다', x: 2248, y: 1095 },
            ],
          },
          { id: 'other', name: '별도 뷰', groups: [], notes: [{ id: 'other-note', text: '포함되지 않는 별도 뷰', x: 0, y: 0 }],
            instances: [{ id: 'elsewhere', tableId: 'unused', x: 0, y: 0 }] },
        ];
        const create = await page.request.post('/api/projects/' + projectId + '/erds', { headers, data: { document } });
        expect(create.status(), await create.text()).toBe(201);
        const path = '/api/erds/' + document.id;
        const url = origin + '/?workspace=1&project=' + projectId + '&erd=' + document.id;
        await page.goto(url);
        await page.getByRole('heading', { name: document.name }).waitFor();
        await page.locator('.react-flow__node[data-id="first"]').waitFor();
        const outside = await page.locator('.react-flow__viewport').evaluate(viewport => {
          (viewport as HTMLElement).style.transform = 'translate(-9000px, -9000px) scale(1)';
          const bounds = viewport.closest('.canvas')!.getBoundingClientRect();
          const nodes = Array.from(viewport.querySelectorAll('.react-flow__node'));
          return nodes.length > 0 && nodes.every(node => {
            const box = node.getBoundingClientRect();
            return box.right < bounds.left || box.bottom < bounds.top || box.left > bounds.right || box.top > bounds.bottom;
          });
        });
        expect(outside).toBe(true);
        await button('이미지 내보내기').click();
        expect(await image.evaluate(node => getComputedStyle(node).color)).toBe('rgb(30, 44, 64)');
        await image.getByLabel('배경 포함').uncheck();
        await image.getByLabel('PNG 배율').selectOption('4');

        const fontRoute = '**/noto-sans-kr.woff2';
        const delayedFont = () => {
          let resume!: () => void;
          let started = false;
          const paused = new Promise<void>(resolve => { resume = resolve; });
          return { resume, paused, started: () => started, requested: () => { started = true; } };
        };
        const timeout = delayedFont();
        await page.route(fontRoute, async route => {
          timeout.requested();
          await timeout.paused;
          await route.abort().catch(() => undefined);
        });
        try {
          await createImage();
          await image.getByRole('alert').getByText(/글꼴을 불러오지 못했습니다/).waitFor();
          expect(timeout.started()).toBe(true);
          expect(await button('PNG 다운로드').count()).toBe(0);
        } finally {
          timeout.resume();
          await page.unroute(fontRoute);
        }
        const delayed = delayedFont();
        await page.route(fontRoute, async route => {
          delayed.requested();
          await delayed.paused;
          await route.continue().catch(() => undefined);
        });
        const edited = structuredClone(document);
        edited.catalog.tables[0].logicalName = '다른 탭 편집';
        try {
          await createImage();
          await expect.poll(delayed.started, { timeout: 3000 }).toBe(true);
          const save = await page.request.put(path, { headers, data: { baseRevision: 1, mutationId: randomUUID(), document: edited } });
          expect(save.status(), await save.text()).toBe(200);
        } finally {
          delayed.resume();
        }
        await image.getByRole('alert').getByText(/출력 한도를 초과합니다/).waitFor();
        expect(await button('PNG 다운로드').count()).toBe(0);
        await page.unroute(fontRoute);
        await image.getByLabel('PNG 배율').selectOption('1');
        await createImage();
        await preview.waitFor();
        const png = await download(page, button('PNG 다운로드'));
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        const rasterWidth = png.readUInt32BE(16);
        const rasterHeight = png.readUInt32BE(20);
        expect(rasterWidth).toBeGreaterThan(1000);
        expect(rasterHeight).toBeGreaterThan(350);

        await image.getByLabel('이미지 형식').selectOption('svg');
        await createImage();
        await preview.waitFor();
        const vector = await download(page, button('SVG 다운로드'));
        const markup = vector.toString('utf8');
        expect(markup).toContain('&lt;script&gt; &amp; 기호');
        expect(markup).toContain('고객 참조 키');
        for (const excluded of ['다른 탭 편집', '부모 지역', 'ticket', '포함되지 않는 별도 뷰']) expect(markup).not.toContain(excluded);

        const rendered = await context.newPage();
        const review = origin + '/__review/';
        await rendered.route(review + 'diagram.png', route => route.fulfill({ contentType: 'image/png', body: png }));
        await rendered.route(review + 'diagram.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: vector }));
        await rendered.goto(review + 'diagram.png');
        const pixels = await rendered.locator('img').evaluate(async element => {
          const image = element as HTMLImageElement;
          await image.decode();
          const canvas = window.document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return { width: canvas.width, height: canvas.height,
            corner: [...context.getImageData(0, 0, 1, 1).data],
            header: [...context.getImageData(70, 96, 1, 1).data] };
        });
        expect(pixels).toEqual({ width: rasterWidth, height: rasterHeight, corner: [0, 0, 0, 0], header: [25, 55, 84, 255] });
        await rendered.goto(review + 'diagram.svg');
        const visual = await rendered.locator('svg').evaluate(async element => {
          const svg = element as SVGSVGElement;
          await window.document.fonts.load('17px "Herd Noto Sans KR"', '배송');
          const texts = Array.from(svg.querySelectorAll('text'));
          const bounds = svg.viewBox.baseVal;
          const title = texts.find(text => text.textContent?.startsWith('배송 일정을'))!;
          const path = title.getBBox();
          const header = title.previousElementSibling as SVGRectElement;
          const fitted = texts.every(text => {
            const box = text.getBBox();
            return box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width &&
              box.y + box.height <= bounds.y + bounds.height;
          });
          const edges = Array.from(svg.querySelectorAll('polyline'));
          return { width: bounds.width, height: bounds.height, fitted,
            fontLoaded: window.document.fonts.check('17px "Herd Noto Sans KR"', '배송'),
            title: title.textContent, headerFits: path.x + path.width < header.x.baseVal.value + header.width.baseVal.value,
            dynamic: svg.querySelectorAll('script, foreignObject, image, a').length,
            edges: edges.length, self: edges.some(line => line.points.getItem(0).x === line.points.getItem(line.points.numberOfItems - 1).x) };
        });
        expect(visual).toEqual({ width: rasterWidth, height: rasterHeight, fitted: true, fontLoaded: true,
          title: longName, headerFits: true, dynamic: 0, edges: 3, self: true });
        const files = process.env.HERD_IMAGE_REVIEW_DIR;
        if (files) {
          await mkdir(files, { recursive: true });
          await writeFile(join(files, 'diagram.png'), png);
          await writeFile(join(files, 'diagram.svg'), vector);
          await rendered.locator('svg').screenshot({ path: join(files, 'svg-rendered.png') });
        }
        await rendered.close();

        await image.getByLabel('출력 범위').selectOption('selected');
        await image.getByLabel(/배송 일정을 집계하는/).check();
        await image.getByLabel('메모 포함').uncheck();
        await image.getByLabel('그룹 포함').uncheck();
        await createImage();
        await image.getByText(/범위 밖 관계 2개 생략/).waitFor();
        const selected = (await download(page, button('SVG 다운로드'))).toString('utf8');
        expect(selected).toContain('배송 일정을 집계하는');
        expect(selected).not.toMatch(/국제 배송 그룹|검증 메모|고객 참조 키/);
        expect(selected.match(/<polyline /g)).toHaveLength(1);
        await image.getByRole('button', { name: '닫기' }).click();

        edited.views[0].groups[0].size = { width: 4004, height: 4000 };
        expect((await page.request.put(path, { headers, data: { baseRevision: 2, mutationId: randomUUID(), document: edited } })).ok()).toBe(true);
        await page.reload();
        await page.getByText('서버 저장됨 · 리비전 3', { exact: true }).waitFor();
        await button('이미지 내보내기').click();
        await createImage();
        await image.getByRole('alert').getByText(/4052 × 4048px가 출력 한도를 초과/).waitFor();
        expect(await button('PNG 다운로드').count()).toBe(0);
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
}, 100_000);
