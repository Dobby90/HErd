import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

const visible = (page: Page, text: string) => page.getByText(text, { exact: true }).first().waitFor();
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const nav = (page: Page) => page.getByRole('complementary', { name: '문서 탐색' });
const inspector = (page: Page) => page.getByRole('complementary', { name: '속성' });
const tableOnCanvas = (page: Page, name: string) => page.locator('.canvas-table').filter({ has: page.getByText(name, { exact: true }) });

async function withEditor(run: (context: BrowserContext, origin: string) => Promise<void>) {
  const output = resolve('build/erd-browser');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(resolve(output, 'run-'));
  const temp = resolve(directory, 'tmp');
  await mkdir(temp);
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  let context: BrowserContext | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let failed = true;
  try {
    server = await createServer({
      configFile: resolve('vite.config.ts'), cacheDir: resolve(directory, 'vite'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not open a loopback port.');
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      args: ['--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 850 },
    });
    await run(context, 'http://127.0.0.1:' + address.port);
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
        if (previousTemp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemp;
        if (!failed) await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

async function addTable(page: Page, name: string) {
  await nav(page).getByRole('button', { name: '테이블 추가', exact: true }).click();
  await inspector(page).getByLabel('물리명', { exact: true }).fill(name);
  await action(page, '테이블 만들기').click();
}
async function addColumn(page: Page, name: string) {
  await action(page, '컬럼 추가').click();
  await inspector(page).getByLabel('물리명', { exact: true }).fill(name);
  await action(page, '컬럼 만들기').click();
}
async function renameDocument(page: Page, name: string) {
  await page.getByLabel('문서 제목', { exact: true }).fill(name);
  await action(page, '제목 적용').click();
}

it('uses the normal editor to create a composite key and FK by dragging, then restores the committed views', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');
    await action(page, '새 문서').click();
    const creation = page.getByRole('dialog', { name: '새 ERD 문서' });
    expect(await creation.getByLabel('SQL 대상').locator('option').allTextContents()).toEqual(['PostgreSQL 17']);
    await creation.getByLabel('새 문서 제목').fill('물류');
    await action(page, '문서 만들기').click();
    await page.getByRole('heading', { name: '물류', exact: true }).waitFor();
    await addTable(page, 'parents');
    await addColumn(page, 'region');
    await addColumn(page, 'number');
    await action(page, 'PK 추가').click();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('parents_pk');
    for (const name of ['region', 'number']) {
      await page.getByLabel('추가할 키 컬럼').selectOption({ label: name });
      await action(page, '키 컬럼 추가').click();
    }
    await action(page, '제약 만들기').click();

    await addTable(page, 'children');
    await addColumn(page, 'parent_region');
    await addColumn(page, 'parent_number');
    await page.locator('.react-flow__controls-fitview').click();
    const source = tableOnCanvas(page, 'children').getByLabel('parent_region 연결점', { exact: true });
    const destination = tableOnCanvas(page, 'parents').getByLabel('region 참조점', { exact: true });
    await source.waitFor();
    await destination.waitFor();
    const sourceBox = await source.boundingBox();
    const destinationBox = await destination.boundingBox();
    if (!sourceBox || !destinationBox) throw new Error('Cannot locate visible FK handles.');
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(destinationBox.x + destinationBox.width / 2, destinationBox.y + destinationBox.height / 2, { steps: 15 });
    await page.mouse.up();

    const relationship = page.getByRole('dialog', { name: '외래 키 설정' });
    await relationship.waitFor();
    await relationship.getByLabel('물리명', { exact: true }).fill('children_parent_fk');
    await relationship.getByLabel('2. number에 대응할 원본 컬럼').selectOption({ label: 'parent_number' });
    await relationship.getByLabel('ON DELETE').selectOption('cascade');
    await action(page, '외래 키 적용').click();
    await page.locator('.fk-edge').waitFor();
    await action(page, '실행 취소').click();
    await page.locator('.fk-edge').waitFor({ state: 'detached' });
    await action(page, '다시 실행').click();
    await page.locator('.fk-edge').waitFor();

    await action(page, '뷰 복제').click();
    await nav(page).getByRole('button', { name: 'parents', exact: true }).click();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('parent_records');
    await action(page, '테이블 적용').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await action(page, '기본 뷰').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 뷰 복제').click();
    await nav(page).getByRole('button', { name: 'parent_records', exact: true }).click();
    await action(page, '이 뷰에서 숨기기').click();
    await tableOnCanvas(page, 'parent_records').waitFor({ state: 'detached' });
    expect(await nav(page).getByRole('button', { name: 'parent_records', exact: true }).count()).toBe(1);
    await action(page, '기본 뷰').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await visible(page, '브라우저 저장 완료');
    await page.reload();
    await visible(page, '브라우저 복구 완료');
    await page.getByRole('heading', { name: '물류', exact: true }).waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 뷰 복제').click();
    await tableOnCanvas(page, 'children').waitFor();
    expect(await tableOnCanvas(page, 'parent_records').count()).toBe(0);

    await action(page, '기본 뷰').click();
    await nav(page).getByRole('button', { name: 'parent_records', exact: true }).click();
    await action(page, '스키마에서 실제 삭제').click();
    const impact = page.getByRole('dialog', { name: '스키마 삭제 영향' });
    await impact.getByText(/children_parent_fk/).waitFor();
    await action(page, '실제 삭제 확인').click();
    await page.locator('.fk-edge').waitFor({ state: 'detached' });
    await action(page, '실행 취소').click();
    await page.locator('.fk-edge').waitFor();
  });
}, 90_000);

it('isolates stale tabs, preserves both versions, and retries failed reads and writes', async () => {
  await withEditor(async (context, origin) => {
    await context.addInitScript(() => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, version) {
        if (sessionStorage.getItem('erd-test-idb-error')) {
          throw new DOMException('Recovery storage fault', 'QuotaExceededError');
        }
        return open.call(this, name, version);
      };
    });
    const first = context.pages()[0] ?? await context.newPage();
    const second = await context.newPage();
    first.setDefaultTimeout(8_000);
    second.setDefaultTimeout(8_000);
    await first.goto(origin);
    await visible(first, '브라우저 임시 저장 대기');
    await renameDocument(first, '공유 기준');
    await visible(first, '브라우저 저장 완료');
    await second.goto(origin);
    await visible(second, '브라우저 복구 완료');
    await visible(first, '다른 탭에서 이 문서를 열었습니다.');
    await visible(second, '다른 탭에서 이 문서를 열었습니다.');

    await renameDocument(first, '최신 복구본');
    await visible(first, '브라우저 저장 완료');
    await renameDocument(second, '늦게 저장한 편집');
    await visible(second, '탭 충돌 · 별도 복구본 저장 완료');
    await second.reload();
    await visible(second, '탭 충돌 복구본을 열었습니다.');
    await second.getByRole('heading', { name: '늦게 저장한 편집', exact: true }).waitFor();
    await first.reload();
    await visible(first, '브라우저 복구 완료');
    await first.getByRole('heading', { name: '최신 복구본', exact: true }).waitFor();

    await first.evaluate(() => sessionStorage.setItem('erd-test-idb-error', 'true'));
    await renameDocument(first, '저장 재시도');
    await visible(first, '브라우저 저장 공간이 부족합니다.');
    await first.getByRole('heading', { name: '저장 재시도', exact: true }).waitFor();
    const reader = await context.newPage();
    reader.setDefaultTimeout(8_000);
    await reader.goto(origin);
    await reader.getByRole('heading', { name: '최신 복구본', exact: true }).waitFor();
    await first.evaluate(() => sessionStorage.removeItem('erd-test-idb-error'));
    await action(first, '다시 시도').click();
    await visible(first, '브라우저 저장 완료');

    await reader.evaluate(() => sessionStorage.setItem('erd-test-idb-error', 'true'));
    await reader.reload();
    await visible(reader, '브라우저 복구본을 읽을 수 없습니다.');
    await reader.evaluate(() => sessionStorage.removeItem('erd-test-idb-error'));
    await action(reader, '다시 시도').click();
    await reader.getByRole('heading', { name: '저장 재시도', exact: true }).waitFor();

    const rewriteVersion = (page: Page, version: number) => page.evaluate(formatVersion => new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('erd-local-recovery', 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        const request = store.get(JSON.stringify(['anonymous:local', 'shop-sample']));
        request.onsuccess = () => {
          const draft = request.result;
          const document = JSON.parse(draft.serialized);
          store.put({ ...draft, formatVersion, serialized: JSON.stringify({ ...document, formatVersion }) });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), version);
    await rewriteVersion(reader, 99);
    await reader.reload();
    await visible(reader, '이 복구본은 더 최신 문서 형식입니다.');
    await action(reader, '다시 시도').click();
    await visible(reader, '이 복구본은 더 최신 문서 형식입니다.');
    await rewriteVersion(reader, 1);
    await action(reader, '다시 시도').click();
    await reader.getByRole('heading', { name: '저장 재시도', exact: true }).waitFor();
  });
}, 90_000);
