import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import type { ErdDocument } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import type { Mutation, ServerDocument } from '../apps/web/src/project-api.js';
import { withBrowser } from './support/browser.js';

const visible = (page: Page, text: string) => page.getByText(text, { exact: true }).first().waitFor();
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const nav = (page: Page) => page.getByRole('complementary', { name: '문서 탐색' });
const inspector = (page: Page) => page.getByRole('complementary', { name: '속성' });
const tab = (page: Page, name: string) => inspector(page).getByRole('tab', { name, exact: true });
const tableOnCanvas = (page: Page, name: string) => page.locator('.canvas-table').filter({ has: page.getByText(name, { exact: true }) });

const projectId = 'editor-project';
const date = '2026-01-01T00:00:00.000Z';
const waitSaved = (page: Page) => page.locator('.save-state').filter({ hasText: /서버 저장됨 · 리비전 / }).waitFor();

async function openEditor(page: Page, origin: string, document = sampleDocument, open = true) {
  const documents = new Map<string, ServerDocument>([[document.id, { document, revision: 1, updatedAt: date }]]);
  const project = { id: projectId, name: '편집기 테스트', role: 'owner', createdBy: 'browser-user', updatedAt: date };
  const base = '/api/projects/' + projectId;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: {
      user: { id: 'browser-user', displayName: '편집기 사용자', isAdmin: false },
      csrfToken: 'browser-csrf', auth: { oidc: false, development: false, local: true },
    } });
    if (path === base) return route.fulfill({ json: { ...project, documentCount: documents.size } });
    if (path === base + '/erds') {
      if (request.method() === 'POST') {
        const { document } = request.postDataJSON() as { document: ErdDocument };
        const saved = { document, revision: 1, updatedAt: date };
        documents.set(document.id, saved);
        return route.fulfill({ status: 201, json: saved });
      }
      return route.fulfill({ json: [...documents.values()].map(({ document, revision, updatedAt }) => ({
        id: document.id, title: document.name, target: document.target, revision, updatedAt,
      })) });
    }
    const saved = documents.get(path.slice('/api/erds/'.length));
    if (!path.startsWith('/api/erds/') || !saved) return route.fulfill({ status: 404, json: { message: 'Fixture resource not found.' } });
    if (request.method() !== 'PUT') return route.fulfill({ json: saved });
    const mutation = request.postDataJSON() as Mutation;
    if (mutation.baseRevision !== saved.revision) return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
    const next = { document: mutation.document, revision: saved.revision + 1, updatedAt: date };
    documents.set(next.document.id, next);
    return route.fulfill({ json: { revision: next.revision, updatedAt: next.updatedAt } });
  });
  await page.goto(origin + '/?project=' + projectId + (open ? '&erd=' + document.id : ''));
  if (open) await waitSaved(page);
}

function savedDocument(page: Page) {
  return page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('erd');
    return await fetch('/api/erds/' + id).then(response => response.json()) as ServerDocument;
  });
}

async function createErd(page: Page, name: string) {
  await action(page, '새 ERD').click();
  const dialog = page.getByRole('dialog', { name: '새 서버 ERD' });
  expect(await dialog.getByLabel('SQL 대상').locator('option').allTextContents()).toEqual(['PostgreSQL 17']);
  await dialog.getByLabel('ERD 이름').fill(name);
  await action(page, 'ERD 생성').click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await waitSaved(page);
}

async function addTable(page: Page, name: string) {
  await nav(page).getByRole('button', { name: '테이블 추가', exact: true }).click();
  await inspector(page).getByLabel('물리명', { exact: true }).fill(name);
  await action(page, '테이블 만들기').click();
}
async function addColumn(page: Page, name: string) {
  await tab(page, '컬럼').click();
  await action(page, '컬럼 추가').click();
  await inspector(page).getByLabel('물리명', { exact: true }).fill(name);
  await action(page, '컬럼 만들기').click();
}

it('lists full view first and shows table comments in the inspector', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const document = structuredClone(sampleDocument);
    const tableComment = document.catalog.tables.find(table => table.id === 'users')!.description!;
    const columnComment = '고객 식별자';
    document.catalog.columns.find(column => column.id === 'user-id')!.description = columnComment;
    await openEditor(page, origin, document);

    const mode = page.getByLabel('이름 표시');
    const nameOptions = ['전체 보기', '논리명', '물리명'];
    expect(await mode.inputValue()).toBe('physical');
    expect(await mode.locator('option').allTextContents()).toEqual(nameOptions);
    await mode.selectOption('both');
    const card = tableOnCanvas(page, 'users');
    await card.getByText('고객', { exact: true }).waitFor();
    await card.getByText(columnComment, { exact: true }).waitFor();
    expect(await card.getByText(tableComment, { exact: true }).count()).toBe(0);

    await card.locator(':scope > strong > svg').first().click();
    await tab(page, '이름·배치').click();
    expect(await inspector(page).getByRole('textbox', { name: '설명', exact: true }).inputValue()).toBe(tableComment);

    await action(page, '내보내기').click();
    await action(page, '이미지 내보내기').click();
    const imageNames = page.getByRole('dialog', { name: '뷰 이미지 내보내기' }).getByLabel('표시할 이름');
    expect(await imageNames.inputValue()).toBe('both');
    expect(await imageNames.locator('option').allTextContents()).toEqual(nameOptions);
  });
}, 60_000);

it('fits visible names, reuses canvas widths for arrangement, and keeps inspector actions accessible', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const document = structuredClone(sampleDocument);
    const longTable = 'customer_subscription_notification_settings';
    const longColumn = 'external_customer_subscription_reference_id';
    document.catalog.tables[0].physicalName = longTable;
    document.catalog.tables[1].physicalName = 'orders_with_a_saved_custom_width';
    document.catalog.columns.find(column => column.id === 'product-name')!.physicalName = longColumn;
    await openEditor(page, origin, document);
    const users = page.locator('[data-id="overview-users"] .canvas-table');
    const products = page.locator('[data-id="overview-products"] .canvas-table');
    const orders = page.locator('[data-id="overview-orders"] .canvas-table');
    const width = (card: typeof users) => card.evaluate(element => (element as HTMLElement).offsetWidth);
    const fits = (field: typeof users) => field.evaluate(element => element.scrollWidth <= element.clientWidth);
    expect(await width(users)).toBeGreaterThan(195);
    expect(await width(products)).toBeGreaterThan(195);
    expect(await width(orders)).toBe(240);
    expect(await fits(users.locator('.canvas-table-text'))).toBe(true);
    expect(await fits(products.getByRole('button', { name: longColumn + ' 이름 편집' }))).toBe(true);

    await action(page, '이름순 그리드 재배치').click();
    await waitSaved(page);
    const placements = (await savedDocument(page)).document.views[0].instances;
    const customer = placements.find(item => item.id === 'overview-users')!;
    const product = placements.find(item => item.id === 'overview-products')!;
    expect(product.x - customer.x).toBeGreaterThanOrEqual(await width(users) + 60);

    await action(page, '전체 보기').click();
    await users.locator(':scope > strong > svg').first().click();
    await users.getByRole('button', { name: longTable + ' 테이블 삭제' }).waitFor();
    expect(await users.getByRole('button', { name: longTable + ' 속성' }).count()).toBe(0);
    await inspector(page).getByRole('heading', { name: longTable, exact: true }).waitFor();
    await tab(page, '제약').click();
    const constraintAdd = await inspector(page).getByRole('group', { name: '제약 추가' }).boundingBox();
    const constraintList = await inspector(page).getByRole('button', { name: 'PK · users_pkey' }).boundingBox();
    expect(constraintAdd!.y).toBeLessThan(constraintList!.y);
    await tab(page, '인덱스').click();
    await inspector(page).getByRole('button', { name: '인덱스 추가' }).waitFor();
    await tab(page, '이름·배치').click();
    await inspector(page).getByRole('heading', { name: '현재 뷰 배치' }).waitFor();
    await inspector(page).getByRole('button', { name: '현재 뷰에서 제거' }).waitFor();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('customers');
    await inspector(page).getByRole('button', { name: '테이블 적용' }).click();
    await expect.poll(() => width(users)).toBe(195);

    await page.setViewportSize({ width: 390, height: 844 });
    const panes = page.getByRole('group', { name: '편집기 영역' });
    await panes.getByRole('button', { name: '속성' }).click();
    await inspector(page).getByRole('heading', { name: 'customers', exact: true }).waitFor();
    await tab(page, '이름·배치').waitFor();
  });
}, 60_000);

it('deletes selected canvas notes and groups with confirmation and keeps grouped objects', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const group = page.locator('[data-id="sales"]');
    const note = page.locator('[data-id="overview-note"]');
    const deleteGroup = group.getByRole('button', { name: '주문 처리 그룹 삭제' });
    const deleteNote = note.getByRole('button', { name: '메모 삭제' });
    expect(await deleteGroup.count()).toBe(0);
    expect(await deleteNote.count()).toBe(0);
    await group.locator('.group-name').click();
    await deleteGroup.click();
    const confirmGroup = page.getByRole('dialog', { name: '그룹 삭제' });
    await confirmGroup.getByText(/테이블과 메모는 그룹에서 분리/).waitFor();
    await confirmGroup.getByRole('button', { name: '그룹 삭제' }).click();
    await group.waitFor({ state: 'detached' });
    await note.waitFor();
    await waitSaved(page);
    const ungrouped = (await savedDocument(page)).document.views[0];
    expect(ungrouped.groups).toEqual([]);
    expect(ungrouped.instances).toHaveLength(sampleDocument.views[0].instances.length);
    expect(ungrouped.instances.every(instance => !instance.groupId)).toBe(true);
    expect(ungrouped.notes).toMatchObject([{ id: 'overview-note' }]);
    expect(ungrouped.notes[0].groupId).toBeUndefined();

    await action(page, '실행 취소').click();
    await group.waitFor();
    await note.locator('.note-text').click();
    await deleteNote.click();
    const confirmNote = page.getByRole('dialog', { name: '메모 삭제' });
    await confirmNote.getByRole('button', { name: '취소' }).click();
    await note.waitFor();
    await deleteNote.click();
    await confirmNote.getByRole('button', { name: '메모 삭제' }).click();
    await note.waitFor({ state: 'detached' });
    await waitSaved(page);
    const withoutNote = (await savedDocument(page)).document.views[0];
    expect(withoutNote.notes).toEqual([]);
    expect(withoutNote.groups).toEqual(sampleDocument.views[0].groups);
    expect(withoutNote.instances).toEqual(sampleDocument.views[0].instances);
  });
}, 60_000);

it('folds and reopens the schema panel on desktop and mobile', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const canvas = page.locator('.canvas');
    const canvasWidth = () => canvas.evaluate(element => element.getBoundingClientRect().width);
    const search = nav(page).getByRole('searchbox');
    const collapse = nav(page).getByRole('button', { name: '스키마 접기' });
    const expand = nav(page).getByRole('button', { name: '스키마 펼치기' });
    const expandedWidth = await canvasWidth();
    await search.fill('orders');
    await collapse.press('Enter');
    await search.waitFor({ state: 'hidden' });
    expect(await expand.getAttribute('aria-expanded')).toBe('false');
    expect(await expand.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await canvasWidth()).toBeGreaterThan(expandedWidth);
    await expand.press('Enter');
    await search.waitFor();
    expect(await collapse.getAttribute('aria-expanded')).toBe('true');
    expect(await search.inputValue()).toBe('orders');
    expect(await canvasWidth()).toBe(expandedWidth);

    await page.setViewportSize({ width: 390, height: 844 });
    const panes = page.getByRole('group', { name: '편집기 영역' });
    const schema = panes.getByRole('button', { name: '스키마' });
    const diagram = panes.getByRole('button', { name: '다이어그램' });
    await schema.click();
    await collapse.click();
    await nav(page).waitFor({ state: 'hidden' });
    expect(await diagram.getAttribute('aria-pressed')).toBe('true');
    expect(await diagram.evaluate(element => element === document.activeElement)).toBe(true);
    await schema.click();
    await search.waitFor();
    expect(await search.inputValue()).toBe('orders');
  });
});

it('fits the view on first open and exposes table tabs and export with the keyboard', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    await openEditor(page, origin);
    const canvas = page.locator('.canvas');
    const tables = canvas.locator('.canvas-table');
    await tables.first().waitFor();
    await expect.poll(() => canvas.evaluate(element => {
      const area = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('.canvas-table')).every(table => {
        const box = table.getBoundingClientRect();
        return box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom;
      });
    })).toBe(true);

    await nav(page).getByRole('button', { name: 'orders', exact: true }).click();
    const columns = tab(page, '컬럼');
    expect(await columns.getAttribute('aria-selected')).toBe('true');
    await inspector(page).getByRole('tabpanel', { name: '컬럼' }).getByRole('button', { name: 'user_id' }).waitFor();
    await expect.poll(() => canvas.locator('.fk-edge.related-edge').count()).toBe(2);
    expect(await canvas.locator('.logical-edge.muted-edge').count()).toBe(1);
    await columns.press('ArrowRight');
    await inspector(page).getByRole('tabpanel', { name: '제약' }).getByRole('button', { name: '외래 키 추가' }).waitFor();

    const exportMenu = action(page, '내보내기');
    await exportMenu.press('Enter');
    await page.keyboard.press('Tab');
    await expect.poll(() => page.getByRole('button', { name: 'DDL 내보내기' }).evaluate(element => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    const imageExport = action(page, '이미지 내보내기');
    expect(await imageExport.evaluate(element => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await exportMenu.getAttribute('aria-expanded')).toBe('false');
    expect(await exportMenu.evaluate(element => element === document.activeElement)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const panes = page.getByRole('group', { name: '편집기 영역' });
    await panes.getByRole('button', { name: '다이어그램' }).click();
    await canvas.waitFor();
    expect(await nav(page).count()).toBe(0);
    await panes.getByRole('button', { name: '스키마' }).click();
    await nav(page).getByRole('button', { name: 'users', exact: true }).click();
    await inspector(page).getByRole('heading', { name: 'users', exact: true }).waitFor();
    expect(await panes.getByRole('button', { name: '속성' }).getAttribute('aria-pressed')).toBe('true');
    await tables.first().waitFor({ state: 'hidden' });
  });
});

it('uses the normal editor to create a composite key and FK by dragging, then restores the committed views', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin, sampleDocument, false);
    await createErd(page, '물류');
    await addTable(page, 'parents');
    await addColumn(page, 'region');
    await addColumn(page, 'number');
    await tab(page, '제약').click();
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

    await action(page, '뷰 설정').click();
    await action(page, '뷰 복제').click();
    await nav(page).getByRole('button', { name: 'parents', exact: true }).click();
    await tab(page, '이름·배치').click();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('parent_records');
    await action(page, '테이블 적용').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await action(page, '기본 뷰').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 뷰 복제').click();
    await nav(page).getByRole('button', { name: 'parent_records', exact: true }).click();
    await tab(page, '이름·배치').click();
    await action(page, '현재 뷰에서 제거').click();
    await tableOnCanvas(page, 'parent_records').waitFor({ state: 'detached' });
    expect(await nav(page).getByRole('button', { name: 'parent_records', exact: true }).count()).toBe(1);
    await action(page, '기본 뷰').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await page.getByRole('heading', { name: '물류', exact: true }).waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 뷰 복제').click();
    await tableOnCanvas(page, 'children').waitFor();
    expect(await tableOnCanvas(page, 'parent_records').count()).toBe(0);

    await action(page, '기본 뷰').click();
    await nav(page).getByRole('button', { name: 'parent_records', exact: true }).click();
    await tab(page, '이름·배치').click();
    await action(page, '스키마에서 테이블 삭제').click();
    const impact = page.getByRole('dialog', { name: '스키마 삭제 영향' });
    await impact.getByText(/children_parent_fk/).waitFor();
    await action(page, '실제 삭제 확인').click();
    await page.locator('.fk-edge').waitFor({ state: 'detached' });
    await action(page, '실행 취소').click();
    await page.locator('.fk-edge').waitFor();
  });
}, 90_000);

it('previews column deletion in the editor and restores the column and its FK together on undo', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
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
    await impact.getByText(/order_items_order_fk/).waitFor();
    await impact.getByText('키·제약 1개 삭제', { exact: true }).click();
    await impact.getByText(/orders_pkey/).waitFor();
    await impact.getByText('주문 전체', { exact: true }).waitFor();
    await impact.getByText('상품 연결', { exact: true }).waitFor();
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
    await waitSaved(page);
  });
}, 90_000);

it('commits schema form values and reloads server documents with object-specific name diagnostics', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
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
    await tab(page, '이름·배치').click();
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
    await waitSaved(page);

    const savedBeforeCancel = await savedDocument(page);
    await property('sku').click();
    await field('물리명').fill('cancelled_sku');
    await property('입력 취소').click();
    expect(await savedDocument(page)).toEqual(savedBeforeCancel);

    await tab(page, '제약').click();
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
      await tab(page, '인덱스').click();
      await action(page, '인덱스 추가').click();
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

    await waitSaved(page);
    const saved = await savedDocument(page);
    expect(saved.document).toMatchObject({ id: sampleDocument.id, formatVersion: 1 });
    expect(saved.revision).toBeGreaterThan(savedBeforeCancel.revision);
    const { catalog } = saved.document;
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
    await waitSaved(page);
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
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);

    for (const [name, target, onDelete, onUpdate] of [
      ['users_parent_fk', 'users', 'set-null', 'cascade'],
      ['users_product_fk', 'products', 'restrict', 'no-action'],
    ]) {
      await nav(page).getByRole('button', { name: 'users', exact: true }).click();
      await addColumn(page, name.replace('_fk', '_id'));
      await tab(page, '제약').click();
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
    await tab(page, '제약').click();
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
    await waitSaved(page);
    const { catalog, relationships } = (await savedDocument(page)).document;
    expect(catalog.constraints.slice(-3)).toMatchObject([
      { kind: 'fk', physicalName: 'users_parent_fk', tableId: 'users', targetTableId: 'users', onDelete: 'set-null', onUpdate: 'cascade' },
      { kind: 'fk', physicalName: 'users_product_fk', tableId: 'users', targetTableId: 'products', onDelete: 'restrict', onUpdate: 'no-action' },
      { kind: 'fk', physicalName: 'products_owner_fk', tableId: 'products', targetTableId: 'users' },
    ]);
    expect(relationships.at(-1)).toMatchObject({ name: '상품과 고객', sourceTableId: 'products', targetTableId: 'users', cardinality: 'many-to-many' });
  });
}, 90_000);

it('creates and edits a view with shared tables, a group, and a plain-text note', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const workspace = page.getByRole('region', { name: '다이어그램' });
    const search = nav(page).getByRole('searchbox');
    await search.fill('order_items');
    expect(await nav(page).getByRole('button', { name: 'users', exact: true }).count()).toBe(0);
    await nav(page).getByRole('button', { name: 'order_items', exact: true }).waitFor();
    await search.clear();

    await action(page, '뷰 추가').click();
    await page.getByLabel('새 뷰 이름').fill('작업용');
    await action(page, '뷰 만들기').click();
    await action(page, '뷰 설정').click();
    await page.getByRole('dialog', { name: '뷰 설정' }).getByLabel('뷰 이름', { exact: true }).fill('작업용 상세');
    await action(page, '뷰 이름 적용').click();
    await workspace.getByRole('heading', { name: '작업용 상세' }).waitFor();
    for (const name of ['users', 'orders']) {
      await nav(page).getByRole('button', { name, exact: true }).click();
      await tab(page, '이름·배치').click();
      await action(page, '현재 뷰에 배치').click();
    }
    await action(page, '추가').click();
    await action(page, '그룹 추가').click();
    await inspector(page).getByLabel('그룹 이름').fill('배송 그룹');
    await action(page, '그룹 적용').click();
    await action(page, '추가').click();
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
    await tab(page, '이름·배치').click();
    await inspector(page).getByLabel('컬럼 접기').check();
    await inspector(page).getByRole('combobox', { name: /^그룹/ }).selectOption({ label: '배송 그룹' });
    await action(page, '배치 적용').click();
    await expect.poll(() => tableOnCanvas(page, '주문').locator('.canvas-column').count()).toBe(0);
    await page.locator('.fk-edge').waitFor();
    const map = page.locator('.react-flow__minimap');
    const toggle = action(page, '미니맵');
    expect(await map.count()).toBe(0);
    await toggle.click();
    await map.waitFor();
    const canvasBox = await page.locator('.canvas').boundingBox();
    const mapBox = await map.boundingBox();
    expect(mapBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height);
    const viewport = page.locator('.react-flow__viewport');
    const beforePan = await viewport.getAttribute('style');
    await page.mouse.move(mapBox!.x + 40, mapBox!.y + 30);
    await page.mouse.down();
    await page.mouse.move(mapBox!.x + 70, mapBox!.y + 45, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan);
    await toggle.click();
    await map.waitFor({ state: 'detached' });

    await waitSaved(page);
    const original = (await savedDocument(page)).document.views.find(view => view.name === '작업용 상세');
    if (!original) throw new Error('Missing the committed view.');
    await action(page, '뷰 설정').click();
    await action(page, '뷰 복제').click();
    await waitSaved(page);
    const copy = (await savedDocument(page)).document.views.find(view => view.name === '작업용 상세 복제');
    if (!copy) throw new Error('Missing the cloned view.');
    expect(copy.groups[0]).toMatchObject({ name: '배송 그룹' });
    expect(copy.groups[0].id).not.toBe(original.groups[0].id);
    expect(copy.notes[0]).toMatchObject({ text: memo, groupId: copy.groups[0].id });
    expect(copy.notes[0].id).not.toBe(original.notes[0].id);
    expect(copy.instances.map(item => item.tableId)).toEqual(original.instances.map(item => item.tableId));
    expect(copy.instances.find(item => item.tableId === 'orders')).toMatchObject({ groupId: copy.groups[0].id, collapsed: true });

    await action(page, '뷰 설정').click();
    page.once('dialog', dialog => dialog.accept());
    await action(page, '뷰 삭제').click();
    await nav(page).getByRole('button', { name: '작업용 상세 복제', exact: true }).waitFor({ state: 'detached' });
    await action(page, '작업용 상세').click();
    await tableOnCanvas(page, '주문').waitFor();
    await action(page, '주문 전체').click();
    await tableOnCanvas(page, 'orders').waitFor();
  });
}, 90_000);

it('preserves advanced data and indexed SQL in existing server documents', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);

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
    await openEditor(page, origin, legacy);
    await nav(page).getByText('SQL 지원', { exact: true }).click();
    for (const feature of ['ENUM', 'SEQUENCE', 'IDENTITY']) await visible(page, feature + ' · 보존 전용');
    await visible(page, 'DDL 가져오기 · 지원');
    await visible(page, 'DDL 내보내기 · 지원');
    await nav(page).getByRole('button', { name: 'products', exact: true }).click();
    await inspector(page).getByRole('button', { name: 'name', exact: true }).click();
    await inspector(page).getByLabel('설명', { exact: true }).fill('편집한 설명');
    await action(page, '컬럼 적용').click();
    await waitSaved(page);
    await tab(page, '인덱스').click();
    await inspector(page).getByRole('button', { name: 'INDEX · products_name_idx', exact: true }).click();
    const sqlInput = inspector(page).getByRole('textbox', { name: '인덱스 SQL 식 1', exact: true });
    expect(await sqlInput.inputValue()).toBe(expression.sql.replace(/\r\n/g, '\n'));
    await inspector(page).getByLabel('설명', { exact: true }).fill('인덱스 설명만 변경');
    await action(page, '인덱스 적용').click();
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await inspector(page).getByText('보존된 SQL 식을 검토하세요.', { exact: true }).waitFor();

    const restored = (await savedDocument(page)).document;
    expect(restored.catalog.columns.find(column => column.id === 'product-name')).toEqual({ ...productName, description: '편집한 설명' });
    expect(restored.catalog.columns.find(column => column.id === 'user-id')).toEqual(legacy.catalog.columns[0]);
    expect(restored.catalog.enums).toEqual(legacy.catalog.enums);
    expect(restored.catalog.sequences).toEqual(legacy.catalog.sequences);
    expect(restored.extensions).toEqual(legacy.extensions);
    expect(restored.catalog.indexes[0]).toEqual({ ...legacyIndex, description: '인덱스 설명만 변경' });
  });
}, 90_000);

it('pans and zooms the canvas and commits a snapped multi-selection drag as one document-local step', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
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
    await waitSaved(page);

    const original = sampleDocument.views[0].instances;
    const moved = (await savedDocument(page)).document.views[0].instances;
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
    await waitSaved(page);
    expect((await savedDocument(page)).document.views[0].instances).toEqual(original);
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);
    await action(page, '다시 실행').click();
    await waitSaved(page);
    expect((await savedDocument(page)).document.views[0].instances).toEqual(moved);

    await action(page, 'ERD 목록').click();
    await createErd(page, '별도 이력');
    expect(await action(page, '실행 취소').isDisabled()).toBe(true);
    await action(page, 'ERD 목록').click();
    await action(page, sampleDocument.name).click();
    await page.getByRole('heading', { name: sampleDocument.name, exact: true }).waitFor();
    await action(page, '실행 취소').click();
    await waitSaved(page);
    expect((await savedDocument(page)).document.views[0].instances).toEqual(original);

    await tableOnCanvas(page, 'users').getByText('users', { exact: true }).click();
    const userNode = page.locator('.react-flow__node-table').filter({ has: page.getByText('users', { exact: true }) });
    const xOnCanvas = () => userNode.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
    const originalUser = original.find(item => item.tableId === 'users');
    if (!originalUser) throw new Error('Missing users placement.');
    await expect.poll(xOnCanvas).toBe(originalUser.x);
    await userNode.press('ArrowRight');
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
    await waitSaved(page);
    const keyboardMoved = original.map(item => item.id === originalUser.id ? { ...item, x: item.x + 20 } : item);
    expect((await savedDocument(page)).document.views[0].instances).toEqual(keyboardMoved);

    await action(page, '실행 취소').click();
    await waitSaved(page);
    await expect.poll(xOnCanvas).toBe(originalUser.x);
    await action(page, '다시 실행').click();
    await waitSaved(page);
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
    await page.reload();
    await waitSaved(page);
    await expect.poll(xOnCanvas).toBe(originalUser.x + 20);
  });
}, 90_000);
