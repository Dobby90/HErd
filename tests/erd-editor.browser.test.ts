import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import type { Draft } from '../apps/web/src/recovery.js';

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
  // Chromium's Linux singleton socket has a Unix path length limit. The proc path
  // resolves to the same writable directory even under a long worktree mount.
  const chromiumTemp = process.platform === 'linux'
    ? '/proc/' + process.pid + '/cwd/' + relative(process.cwd(), temp)
    : temp;
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
      env: { ...process.env, TMPDIR: chromiumTemp },
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
    const reachable = (handle: typeof source) => handle.evaluate(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2) === element;
    });
    // React Flow applies fitView after layout. A visible DOM handle can still
    // be clipped by the canvas and its current coordinates can hit the sidebar.
    await expect.poll(() => reachable(source)).toBe(true);
    await expect.poll(() => reachable(destination)).toBe(true);
    await source.hover();
    const destinationBox = await destination.boundingBox();
    if (!destinationBox) throw new Error('Cannot locate the FK destination handle.');
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

it('previews column deletion in the editor and restores the column and its FK together on undo', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');
    const impact = page.getByRole('dialog', { name: '스키마 삭제 영향' });
    const confirm = impact.getByRole('button', { name: '실제 삭제 확인', exact: true });
    const close = impact.getByRole('button', { name: '닫기', exact: true });
    async function previewColumnDeletion(table: string, column: string) {
      await nav(page).getByRole('button', { name: table, exact: true }).click();
      await inspector(page).getByRole('button', { name: column, exact: true }).click();
      await inspector(page).getByRole('button', { name: '스키마에서 실제 삭제', exact: true }).click();
    }

    await previewColumnDeletion('products', 'name');
    await impact.getByRole('alert').getByText(/products_name_idx/).waitFor();
    expect(await confirm.isDisabled()).toBe(true);
    await close.click();
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);

    await action(page, '상품 연결').click();
    const orderNumber = tableOnCanvas(page, 'orders').getByText('number', { exact: true });
    const foreignKeys = page.locator('.fk-edge');
    await orderNumber.waitFor();
    await expect.poll(() => foreignKeys.count()).toBe(2);
    await previewColumnDeletion('orders', 'number');
    await impact.getByText(/orders_pkey.*order_items_order_fk/).waitFor();
    await impact.getByText('주문 전체, 상품 연결', { exact: true }).waitFor();
    await close.click();
    await orderNumber.waitFor();
    expect(await foreignKeys.count()).toBe(2);
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);

    await previewColumnDeletion('orders', 'number');
    await confirm.click();
    await orderNumber.waitFor({ state: 'detached' });
    await expect.poll(() => foreignKeys.count()).toBe(1);
    await visible(page, '구조 검증 통과');
    await action(page, '실행 취소').click();
    await orderNumber.waitFor();
    await expect.poll(() => foreignKeys.count()).toBe(2);
    await visible(page, '구조 검증 통과');
    await action(page, '다시 실행').click();
    await orderNumber.waitFor({ state: 'detached' });
    await expect.poll(() => foreignKeys.count()).toBe(1);
    await visible(page, '브라우저 저장 완료');
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
    const firstConflict = await activeDraft(second);
    await nav(second).getByRole('button', { name: /저장된 복구본.*shop-sample/ }).click();
    await second.getByRole('heading', { name: '최신 복구본', exact: true }).waitFor();
    await renameDocument(first, '두 번째 최신 복구본');
    await visible(first, '브라우저 저장 완료');
    await renameDocument(second, '두 번째 늦은 편집');
    await visible(second, '탭 충돌 · 별도 복구본 저장 완료');

    const secondConflict = await activeDraft(second);
    expect(secondConflict.tabId).toBe(firstConflict.tabId);
    expect(secondConflict.key).not.toBe(firstConflict.key);
    const conflictButton = (draft: Draft) => nav(second).getByRole('button', {
      name: `탭 충돌 복구본 · ${draft.updatedAt} · shop-sample`, exact: true,
    });
    await conflictButton(firstConflict).click();
    await second.getByRole('heading', { name: '늦게 저장한 편집', exact: true }).waitFor();
    await conflictButton(secondConflict).click();
    await second.getByRole('heading', { name: '두 번째 늦은 편집', exact: true }).waitFor();
    await conflictButton(firstConflict).click();
    await second.getByRole('heading', { name: '늦게 저장한 편집', exact: true }).waitFor();
    await second.reload();
    await visible(second, '탭 충돌 복구본을 열었습니다.');
    await second.getByRole('heading', { name: '늦게 저장한 편집', exact: true }).waitFor();
    await first.reload();
    await visible(first, '브라우저 복구 완료');
    await first.getByRole('heading', { name: '두 번째 최신 복구본', exact: true }).waitFor();

    await renameDocument(second, '첫 번째 충돌 복구본의 후속 편집');
    await visible(second, '브라우저 저장 완료');
    expect(await activeDraft(second)).toMatchObject({ key: firstConflict.key, generation: firstConflict.generation + 1 });
    expect((await storedDrafts(second)).find(draft => draft.key === secondConflict.key)).toEqual(secondConflict);

    await first.evaluate(() => sessionStorage.setItem('erd-test-idb-error', 'true'));
    await renameDocument(first, '저장 재시도');
    await visible(first, '브라우저 저장 공간이 부족합니다.');
    await first.getByRole('heading', { name: '저장 재시도', exact: true }).waitFor();
    const reader = await context.newPage();
    reader.setDefaultTimeout(8_000);
    await reader.goto(origin);
    await reader.getByRole('heading', { name: '두 번째 최신 복구본', exact: true }).waitFor();
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

    const damagedId = 'recovery-metadata';
    const repairable = {
      ...await activeDraft(reader),
      key: JSON.stringify(['anonymous:local', damagedId]),
      documentId: damagedId,
      serialized: serializeDocument({ ...sampleDocument, id: damagedId, name: '다른 복구본' }),
    };
    const damaged = { ...repairable, updatedAt: new Date(), documentId: { id: damagedId } };
    await putStoredDraft(reader, damaged);
    await renameDocument(reader, '현재 탭의 작업');
    await visible(reader, '브라우저 저장 완료');
    await nav(reader).getByRole('button', { name: '손상된 복구본', exact: true }).click();
    await visible(reader, '복구본이 손상되었습니다.');
    await reader.getByRole('heading', { name: '현재 탭의 작업', exact: true }).waitFor();
    await action(reader, '다시 시도').click();
    await visible(reader, '복구본이 손상되었습니다.');
    expect((await storedDrafts(reader)).find(draft => draft.key === damaged.key)).toMatchObject(damaged);
    await reader.getByRole('heading', { name: '현재 탭의 작업', exact: true }).waitFor();

    await putStoredDraft(reader, repairable);
    await action(reader, '다시 시도').click();
    await reader.getByRole('heading', { name: '다른 복구본', exact: true }).waitFor();
    await visible(reader, '브라우저 복구 완료');
    await nav(reader).getByRole('button', { name: /저장된 복구본.*shop-sample/ }).click();
    await reader.getByRole('heading', { name: '현재 탭의 작업', exact: true }).waitFor();
  });
}, 90_000);

function putStoredDraft(page: Page, draft: unknown) {
  return page.evaluate(record => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('erd-local-recovery', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put(record);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), draft);
}

function storedDrafts(page: Page) {
  return page.evaluate(() => new Promise<Draft[]>((resolve, reject) => {
    const opening = indexedDB.open('erd-local-recovery', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('drafts');
      const reading = transaction.objectStore('drafts').getAll();
      transaction.oncomplete = () => { database.close(); resolve(reading.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

async function activeDraft(page: Page) {
  const key = await page.evaluate(() => sessionStorage.getItem('erd-active-draft'));
  const draft = (await storedDrafts(page)).find(record => record.key === key);
  if (!draft) throw new Error('The active recovery draft was not stored.');
  return draft;
}

it('commits schema form values and restores drafts with object-specific name diagnostics', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');
    const field = (name: string) => inspector(page).getByLabel(name, { exact: true });
    const property = (name: string) => inspector(page).getByRole('button', { name, exact: true });

    await action(page, '네임스페이스 추가').click();
    await field('물리명').fill('stock');
    await action(page, '네임스페이스 만들기').click();
    await field('물리명').fill('inventory');
    await field('설명').fill('Inventory data');
    await action(page, '네임스페이스 적용').click();

    const publicSection = nav(page).locator('.schema-section').filter({
      has: page.getByRole('button', { name: 'public', exact: true }),
    });
    await publicSection.getByRole('button', { name: '테이블 추가', exact: true }).click();
    await field('물리명').fill('parts');
    await action(page, '테이블 만들기').click();
    await inspector(page).getByLabel('네임스페이스').selectOption({ label: 'inventory' });
    await field('논리명').fill('부품');
    await field('설명').fill('Part definitions');
    await action(page, '테이블 적용').click();
    await addColumn(page, 'sku');
    await addColumn(page, 'amount');
    await property('amount').click();
    await inspector(page).getByLabel('자료형').selectOption('numeric');
    await field('타입 인수 (JSON 배열)').fill('[8,2]');
    await field('컬럼 위치').fill('1');
    await field('NULL 허용').uncheck();
    await field('DEFAULT SQL').fill('0');
    await action(page, '컬럼 적용').click();
    await visible(page, '브라우저 저장 완료');

    const savedBeforeCancel = await activeDraft(page);
    await property('sku').click();
    await field('물리명').fill('cancelled_sku');
    await property('입력 취소').click();
    expect(await activeDraft(page)).toEqual(savedBeforeCancel);

    await action(page, 'UNIQUE 추가').click();
    await field('물리명').fill('parts_sku_key');
    for (const name of ['sku', 'amount']) {
      await inspector(page).getByLabel('추가할 키 컬럼').selectOption({ label: name });
      await action(page, '키 컬럼 추가').click();
    }
    await action(page, '키 컬럼 2 위로').click();
    await action(page, '제약 만들기').click();
    await action(page, 'CHECK 추가').click();
    await field('물리명').fill('parts_amount_check');
    await field('CHECK SQL').fill('amount >= 0');
    await action(page, '제약 만들기').click();
    for (const unique of [false, true]) {
      await action(page, 'INDEX 추가').click();
      await field('물리명').fill(unique ? 'parts_unique_idx' : 'parts_amount_idx');
      await field('고유 인덱스').setChecked(unique);
      for (const name of unique ? ['amount', 'sku'] : ['amount']) {
        await inspector(page).getByLabel('인덱스 컬럼').selectOption({ label: name });
        await action(page, '인덱스 컬럼 추가').click();
      }
      if (unique) await action(page, '인덱스 키 2 위로').click();
      await action(page, '인덱스 만들기').click();
    }

    const inventory = nav(page).locator('.schema-section').filter({
      has: page.getByRole('button', { name: 'inventory', exact: true }),
    });
    for (const name of ['', 'parts']) {
      await inventory.getByRole('button', { name: '테이블 추가', exact: true }).click();
      await field('물리명').fill(name);
      await action(page, '테이블 만들기').click();
    }

    await visible(page, '브라우저 저장 완료');
    const draft = await activeDraft(page);
    expect(draft).toMatchObject({ owner: 'anonymous:local', documentId: sampleDocument.id, formatVersion: 1, baseRevision: null });
    expect(Number.isFinite(Date.parse(draft.updatedAt))).toBe(true);
    expect(draft.generation).toBeGreaterThan(savedBeforeCancel.generation);
    const { catalog } = deserializeDocument(draft.serialized);
    const namespace = catalog.namespaces.find(item => item.physicalName === 'inventory');
    const table = catalog.tables.find(item => item.logicalName === '부품');
    const [amount, sku] = (table?.columnIds ?? []).map(id => catalog.columns.find(item => item.id === id));
    const blank = catalog.tables.find(item => item.physicalName === '');
    const duplicate = catalog.tables.find(item => item.physicalName === 'parts' && item.id !== table?.id);
    if (!namespace || !table || !amount || !sku || !blank || !duplicate) throw new Error('Missing schema edits in recovery draft.');
    expect(table).toMatchObject({ namespaceId: namespace.id, physicalName: 'parts', description: 'Part definitions' });
    expect(namespace.description).toBe('Inventory data');
    expect(sku.physicalName).toBe('sku');
    expect(amount).toMatchObject({
      physicalName: 'amount', nullable: false, default: { dialectId: 'postgresql', engineVersion: '17', sql: '0' },
      type: { reference: { kind: 'native', name: 'numeric' }, arguments: [8, 2] },
    });
    expect(catalog.constraints.filter(item => item.tableId === table.id)).toMatchObject([
      { kind: 'unique', physicalName: 'parts_sku_key', columnIds: [amount.id, sku.id] },
      { kind: 'check', physicalName: 'parts_amount_check', expression: { sql: 'amount >= 0' } },
    ]);
    expect(catalog.indexes.filter(item => item.tableId === table.id)).toMatchObject([
      { physicalName: 'parts_amount_idx', unique: false, keys: [{ kind: 'column', columnId: amount.id }] },
      { physicalName: 'parts_unique_idx', unique: true, keys: [
        { kind: 'column', columnId: sku.id }, { kind: 'column', columnId: amount.id },
      ] },
    ]);

    await page.reload();
    await visible(page, '브라우저 복구 완료');
    await visible(page, '구조 검증 통과');
    for (const [id, message] of [
      [blank.id, '물리명을 입력하세요.'],
      [table.id, '같은 PostgreSQL 명명 범위에 동일한 물리명이 있습니다.'],
      [duplicate.id, '같은 PostgreSQL 명명 범위에 동일한 물리명이 있습니다.'],
    ]) {
      await inspector(page).getByRole('listitem').filter({
        has: page.getByRole('button', { name: id, exact: true }),
      }).getByText(message, { exact: true }).waitFor();
    }
  });
}, 90_000);

it('adds reciprocal and self foreign keys and edits an independent logical relationship', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');

    for (const [name, target, onDelete, onUpdate] of [
      ['users_parent_fk', 'users', 'set-null', 'cascade'],
      ['users_product_fk', 'products', 'restrict', 'no-action'],
    ]) {
      await nav(page).getByRole('button', { name: 'users', exact: true }).click();
      await addColumn(page, name.replace('_fk', '_id'));
      await action(page, '외래 키 추가').click();
      const dialog = page.getByRole('dialog', { name: '외래 키 설정' });
      await dialog.getByLabel('물리명', { exact: true }).fill(name);
      await dialog.getByLabel('참조 테이블').selectOption({ label: target });
      await dialog.getByLabel('1. id에 대응할 원본 컬럼').selectOption({ label: name.replace('_fk', '_id') });
      await dialog.getByLabel('ON DELETE').selectOption(onDelete);
      await dialog.getByLabel('ON UPDATE').selectOption(onUpdate);
      await action(page, '외래 키 적용').click();
    }
    await nav(page).getByRole('button', { name: 'products', exact: true }).click();
    await addColumn(page, 'owner_id');
    await action(page, '외래 키 추가').click();
    const dialog = page.getByRole('dialog', { name: '외래 키 설정' });
    await dialog.getByLabel('물리명', { exact: true }).fill('products_owner_fk');
    await dialog.getByLabel('참조 테이블').selectOption({ label: 'users' });
    await dialog.getByLabel('1. id에 대응할 원본 컬럼').selectOption({ label: 'owner_id' });
    await action(page, '외래 키 적용').click();

    await action(page, '관계 추가').click();
    await inspector(page).getByLabel('관계 이름').fill('상품과 고객');
    await inspector(page).getByLabel('원본 테이블').selectOption({ label: 'products' });
    await inspector(page).getByLabel('대상 테이블').selectOption({ label: 'users' });
    await inspector(page).getByLabel('관계 차수').selectOption('many-to-many');
    await action(page, '논리 관계 적용').click();
    await action(page, '상품과 고객').click();
    expect(await inspector(page).getByLabel('관계 차수').inputValue()).toBe('many-to-many');
    await page.locator('.logical-edge').filter({ hasText: '상품과 고객 · 논리' }).waitFor();
    await expect.poll(() => page.locator('.fk-edge').count()).toBe(6);
    await page.locator('.fk-edge').filter({ hasText: '자식 0..N · 부모 0..1' }).first().waitFor();
    await visible(page, '브라우저 저장 완료');
    const { catalog, relationships } = deserializeDocument((await activeDraft(page)).serialized);
    expect(catalog.constraints.slice(-3)).toMatchObject([
      { kind: 'fk', physicalName: 'users_parent_fk', tableId: 'users', targetTableId: 'users', onDelete: 'set-null', onUpdate: 'cascade' },
      { kind: 'fk', physicalName: 'users_product_fk', tableId: 'users', targetTableId: 'products', onDelete: 'restrict', onUpdate: 'no-action' },
      { kind: 'fk', physicalName: 'products_owner_fk', tableId: 'products', targetTableId: 'users' },
    ]);
    expect(relationships.at(-1)).toMatchObject({ name: '상품과 고객', sourceTableId: 'products', targetTableId: 'users', cardinality: 'many-to-many' });
  });
}, 90_000);

it('creates and edits a view with shared tables, a group, and a plain-text note', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');
    const workspace = page.getByRole('region', { name: '다이어그램' });
    const search = nav(page).getByRole('searchbox');
    await search.fill('order_items');
    expect(await nav(page).getByRole('button', { name: 'users', exact: true }).count()).toBe(0);
    await nav(page).getByRole('button', { name: 'order_items', exact: true }).waitFor();
    await search.clear();

    await action(page, '뷰 추가').click();
    await page.getByLabel('새 뷰 이름').fill('작업용');
    await action(page, '뷰 만들기').click();
    await nav(page).getByLabel('뷰 이름', { exact: true }).fill('작업용 상세');
    await action(page, '뷰 이름 적용').click();
    await workspace.getByRole('heading', { name: '작업용 상세' }).waitFor();
    for (const name of ['users', 'orders']) {
      await nav(page).getByRole('button', { name, exact: true }).click();
      await action(page, '현재 뷰에 배치').click();
    }
    await action(page, '그룹 추가').click();
    await inspector(page).getByLabel('그룹 이름').fill('배송 그룹');
    await action(page, '그룹 적용').click();
    await action(page, '메모 추가').click();
    const memo = '<img src="memo.png" alt="memo">';
    await inspector(page).getByLabel('메모 텍스트').fill(memo);
    await inspector(page).getByRole('combobox', { name: /^그룹/ }).selectOption({ label: '배송 그룹' });
    await action(page, '메모 적용').click();
    await workspace.getByText(memo, { exact: true }).waitFor();
    expect(await workspace.locator('.note-text img').count()).toBe(0);

    await workspace.getByLabel('이름 표시').selectOption('logical');
    await tableOnCanvas(page, '주문').waitFor();
    await nav(page).getByRole('button', { name: 'orders', exact: true }).click();
    await inspector(page).getByLabel('컬럼 접기').check();
    await inspector(page).getByRole('combobox', { name: /^그룹/ }).selectOption({ label: '배송 그룹' });
    await action(page, '배치 적용').click();
    await expect.poll(() => tableOnCanvas(page, '주문').locator('.canvas-column').count()).toBe(0);
    await page.locator('.fk-edge').waitFor();
    await page.locator('.react-flow__minimap').waitFor();

    await visible(page, '브라우저 저장 완료');
    const original = deserializeDocument((await activeDraft(page)).serialized).views.find(view => view.name === '작업용 상세');
    if (!original) throw new Error('Missing the committed view.');
    await action(page, '뷰 복제').click();
    await visible(page, '브라우저 저장 완료');
    const copy = deserializeDocument((await activeDraft(page)).serialized).views.find(view => view.name === '작업용 상세 복제');
    if (!copy) throw new Error('Missing the cloned view.');
    expect(copy.groups[0]).toMatchObject({ name: '배송 그룹' });
    expect(copy.groups[0].id).not.toBe(original.groups[0].id);
    expect(copy.notes[0]).toMatchObject({ text: memo, groupId: copy.groups[0].id });
    expect(copy.notes[0].id).not.toBe(original.notes[0].id);
    expect(copy.instances.map(item => item.tableId)).toEqual(original.instances.map(item => item.tableId));
    expect(copy.instances.find(item => item.tableId === 'orders')).toMatchObject({ groupId: copy.groups[0].id, collapsed: true });

    page.once('dialog', dialog => dialog.accept());
    await action(page, '뷰 삭제').click();
    await nav(page).getByRole('button', { name: '작업용 상세 복제', exact: true }).waitFor({ state: 'detached' });
    await action(page, '작업용 상세').click();
    await tableOnCanvas(page, '주문').waitFor();
    await action(page, '주문 전체').click();
    await tableOnCanvas(page, 'orders').waitFor();
  });
}, 90_000);

it('restores a v1 recovery draft and preserves advanced data and indexed SQL when editing other attributes', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');

    const legacy = structuredClone(sampleDocument);
    legacy.catalog.enums.push({ id: 'state-type', physicalName: 'state', namespaceId: 'public-schema', values: ['new', 'paid'] });
    legacy.catalog.sequences.push({ id: 'user-seq', physicalName: 'users_seq', namespaceId: 'public-schema', ownedByColumnId: 'user-id' });
    legacy.catalog.columns[0].identity = 'by-default';
    const productName = legacy.catalog.columns.find(column => column.id === 'product-name');
    if (!productName) throw new Error('Missing fixture column.');
    productName.type = {
      reference: { kind: 'enum', enumId: 'state-type' }, arguments: [], arrayDimensions: 1,
      originalSql: 'public.state[]', attributes: [{ namespace: 'custom', version: 1, data: { keep: true } }],
    };
    legacy.extensions.push({ namespace: 'legacy', version: 1, data: { marker: 'keep' } });
    const expression = {
      ...legacy.target, sql: 'lower(\r\n-- keep the next line\r\nname)', references: ['product-name'],
      referencesComplete: true, invalidated: true as const,
    };
    const legacyIndex = legacy.catalog.indexes[0];
    legacyIndex.keys = [{ kind: 'expression', expression }];
    const key = JSON.stringify(['anonymous:local', legacy.id]);
    await putStoredDraft(page, {
      key, owner: 'anonymous:local', documentId: legacy.id, updatedAt: new Date().toISOString(),
      formatVersion: 1, baseRevision: null, generation: 1, serialized: serializeDocument(legacy),
    });

    await page.reload();
    await visible(page, '브라우저 복구 완료');
    for (const feature of ['ENUM', 'SEQUENCE', 'IDENTITY']) await visible(page, feature + ' · 보존 전용');
    for (const feature of ['DDL 가져오기', 'DDL 내보내기']) await visible(page, feature + ' · 미구현');
    await nav(page).getByRole('button', { name: 'products', exact: true }).click();
    await inspector(page).getByRole('button', { name: 'name', exact: true }).click();
    await inspector(page).getByLabel('설명', { exact: true }).fill('편집한 설명');
    await action(page, '컬럼 적용').click();
    await visible(page, '브라우저 저장 완료');
    await inspector(page).getByRole('button', { name: 'INDEX · products_name_idx', exact: true }).click();
    const sqlInput = inspector(page).getByRole('textbox', { name: '인덱스 SQL 식 1', exact: true });
    expect(await sqlInput.inputValue()).toBe(expression.sql.replace(/\r\n/g, '\n'));
    await inspector(page).getByLabel('설명', { exact: true }).fill('인덱스 설명만 변경');
    await action(page, '인덱스 적용').click();
    await visible(page, '브라우저 저장 완료');
    await page.reload();
    await visible(page, '브라우저 복구 완료');
    await inspector(page).getByText('보존된 SQL 식을 검토하세요.', { exact: true }).waitFor();

    const restored = deserializeDocument((await activeDraft(page)).serialized);
    expect(restored.catalog.columns.find(column => column.id === 'product-name')).toEqual({ ...productName, description: '편집한 설명' });
    expect(restored.catalog.columns.find(column => column.id === 'user-id')).toEqual(legacy.catalog.columns[0]);
    expect(restored.catalog.enums).toEqual(legacy.catalog.enums);
    expect(restored.catalog.sequences).toEqual(legacy.catalog.sequences);
    expect(restored.extensions).toEqual(legacy.extensions);
    expect(restored.catalog.indexes[0]).toEqual({ ...legacyIndex, description: '인덱스 설명만 변경' });
  });
}, 90_000);

it('pans and zooms the canvas and commits a snapped multi-selection drag as one document-local step', async () => {
  await withEditor(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(origin);
    await visible(page, '브라우저 임시 저장 대기');
    const viewport = page.locator('.react-flow__viewport');
    const transform = () => viewport.evaluate(node => {
      const { a, e, f } = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { zoom: a, x: e, y: f };
    });
    const fit = page.locator('.react-flow__controls-fitview');
    await fit.click();
    const fitted = await transform();
    await page.locator('.react-flow__controls-zoomout').click();
    await expect.poll(async () => (await transform()).zoom).toBeLessThan(fitted.zoom);

    const pane = await page.locator('.react-flow__pane').boundingBox();
    if (!pane) throw new Error('Cannot locate the canvas pane.');
    const beforePan = await transform();
    await page.mouse.move(pane.x + pane.width * 0.55, pane.y + pane.height - 25);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(pane.x + pane.width * 0.55 + 35, pane.y + pane.height - 50, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    await expect.poll(async () => (await transform()).x).toBeGreaterThan(beforePan.x);
    await fit.click();
    await expect.poll(async () => (await transform()).zoom).toBeCloseTo(fitted.zoom, 3);
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);

    await tableOnCanvas(page, 'users').getByText('users', { exact: true }).click();
    await tableOnCanvas(page, 'products').getByText('products', { exact: true }).click({ modifiers: ['Shift'] });
    const selected = page.locator('.react-flow__node-table.selected');
    await expect.poll(() => selected.count()).toBe(2);
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);

    const source = await tableOnCanvas(page, 'users').getByText('users', { exact: true }).boundingBox();
    if (!source) throw new Error('Cannot locate the selected users table.');
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 58, start.y + 49, { steps: 12 });
    await page.mouse.up();
    await visible(page, '브라우저 저장 완료');

    const original = sampleDocument.views[0].instances;
    const moved = deserializeDocument((await activeDraft(page)).serialized).views[0].instances;
    for (const item of original) {
      const actual = moved.find(instance => instance.id === item.id);
      if (['users', 'products'].includes(item.tableId)) {
        if (!actual) throw new Error('Missing the dragged table ' + item.tableId);
        expect(actual.x).toBeGreaterThan(item.x);
        expect(actual.y).toBeGreaterThan(item.y);
        expect(actual.x % 20).toBe(0);
        expect(actual.y % 20).toBe(0);
      } else expect(actual).toEqual(item);
    }

    await action(page, '실행 취소').click();
    await visible(page, '브라우저 저장 완료');
    expect(deserializeDocument((await activeDraft(page)).serialized).views[0].instances).toEqual(original);
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);
    await action(page, '다시 실행').click();
    await visible(page, '브라우저 저장 완료');
    expect(deserializeDocument((await activeDraft(page)).serialized).views[0].instances).toEqual(moved);

    await action(page, '새 문서').click();
    await page.getByLabel('새 문서 제목').fill('별도 이력');
    await action(page, '문서 만들기').click();
    await visible(page, '브라우저 저장 완료');
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);
    await nav(page).getByRole('button', { name: /저장된 복구본.*shop-sample/ }).click();
    await page.getByRole('heading', { name: sampleDocument.name, exact: true }).waitFor();
    await action(page, '실행 취소').click();
    await visible(page, '브라우저 저장 완료');
    expect(deserializeDocument((await activeDraft(page)).serialized).views[0].instances).toEqual(original);

    await tableOnCanvas(page, 'users').getByText('users', { exact: true }).click();
    const userNode = page.locator('.react-flow__node-table').filter({ has: page.getByText('users', { exact: true }) });
    const xOnCanvas = () => userNode.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
    const originalUser = original.find(item => item.tableId === 'users');
    if (!originalUser) throw new Error('Missing users placement.');
    await expect.poll(xOnCanvas).toBe(originalUser.x);
    await userNode.press('ArrowRight');
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
    await visible(page, '브라우저 저장 완료');
    const keyboardMoved = original.map(item => item.id === originalUser.id ? { ...item, x: item.x + 20 } : item);
    expect(deserializeDocument((await activeDraft(page)).serialized).views[0].instances).toEqual(keyboardMoved);

    await action(page, '실행 취소').click();
    await visible(page, '브라우저 저장 완료');
    await expect.poll(xOnCanvas).toBe(originalUser.x);
    await action(page, '다시 실행').click();
    await visible(page, '브라우저 저장 완료');
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
    await page.reload();
    await visible(page, '브라우저 복구 완료');
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
  });
}, 90_000);
