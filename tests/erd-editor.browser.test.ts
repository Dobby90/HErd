import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import type { ErdDocument } from '@erd/model';
import { SqlService } from '@erd/sql-service';
import type { GenerateJobOptions } from '@erd/sql-contract';
import { sampleDocument } from '@erd/test-fixtures';
import { createSqlRegistry } from '../apps/api/src/sql-registry.js';
import type { Mutation, ServerDocument } from '../apps/web/src/project-api.js';
import { withBrowser } from './support/browser.js';
import { openExport } from './support/editor-ui.js';

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
    if (request.method() === 'HEAD') return route.fulfill({ status: 200 });
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

it('saves canvas display options across views independently of the name mode', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const document = structuredClone(sampleDocument);
    const tableComment = document.catalog.tables.find(table => table.id === 'users')!.description!;
    const columnComment = '고객 식별자';
    const column = document.catalog.columns.find(column => column.id === 'user-id')!;
    column.description = columnComment;
    column.default = { ...document.target, sql: '42', references: [], referencesComplete: true };
    await openEditor(page, origin, document);

    const mode = page.getByLabel('이름 표시');
    const nameOptions = ['논리명 + 물리명', '논리명', '물리명'];
    expect(await mode.inputValue()).toBe('physical');
    expect(await mode.locator('option').allTextContents()).toEqual(nameOptions);
    await mode.selectOption('both');
    const card = tableOnCanvas(page, 'users');
    await card.getByText('고객', { exact: true }).waitFor();
    for (const comment of [tableComment, columnComment]) {
      expect(await card.getByText(comment, { exact: true }).count()).toBe(0);
    }
    await card.getByText('DEFAULT 42', { exact: true }).waitFor();
    await card.getByText('PK', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'integer 자료형 편집' }).waitFor();

    await card.locator(':scope > strong > svg').first().click();
    await tab(page, '이름·배치').click();
    expect(await inspector(page).getByRole('textbox', { name: '설명', exact: true }).inputValue()).toBe(tableComment);

    await action(page, '내보내기').click();
    await action(page, '이미지 내보내기').click();
    const image = page.getByRole('dialog', { name: '이미지 내보내기' });
    const imageNames = image.getByLabel('표시할 이름');
    expect(await imageNames.inputValue()).toBe('both');
    expect(await imageNames.locator('option').allTextContents()).toEqual(nameOptions);
    await image.getByRole('button', { name: '닫기' }).click();

    const options = page.getByRole('dialog', { name: 'ERD 표시 옵션' });
    const option = (name: string) => options.getByRole('checkbox', { name, exact: true });
    await action(page, 'ERD 표시 옵션').click();
    await option('테이블 코멘트').check();
    await option('컬럼 코멘트').check();
    for (const name of ['컬럼 자료형', 'PK·FK·UNIQUE 배지', '컬럼 기본값', '관계선 라벨', '메모', '그룹', '배경 격자']) {
      await option(name).uncheck();
    }
    await action(page, '표시 옵션 적용').click();
    await card.getByText(tableComment, { exact: true }).waitFor();
    await card.getByText(columnComment, { exact: true }).waitFor();
    for (const value of ['DEFAULT 42', 'PK', 'integer']) {
      expect(await card.getByText(value, { exact: true }).count()).toBe(0);
    }
    expect(await mode.inputValue()).toBe('both');
    expect(await page.locator('.logical-edge').count()).toBe(1);
    expect(await page.locator('.react-flow__edge-text').count()).toBe(0);
    expect(await page.locator('.react-flow__background, .group-name, .note-text').count()).toBe(0);
    await expect.poll(async () => (await savedDocument(page)).document.canvasDisplay?.columnComments, { timeout: 5_000 }).toBe(true);

    await page.reload();
    await card.getByText(columnComment, { exact: true }).waitFor();
    await action(page, '상품 연결').click();
    await tableOnCanvas(page, 'orders').getByText('고객별 주문 번호로 주문을 식별', { exact: true }).waitFor();
    expect(await mode.inputValue()).toBe('physical');
    await action(page, 'ERD 표시 옵션').click();
    await option('컬럼 목록').uncheck();
    await action(page, '표시 옵션 적용').click();
    await page.locator('.canvas-column-slot').first().waitFor({ state: 'detached' });
    await expect.poll(() => page.locator('.fk-edge .react-flow__edge-path').count()).toBeGreaterThan(0);

    await action(page, 'ERD 표시 옵션').click();
    await option('관계선').uncheck();
    await action(page, '표시 옵션 적용').click();
    expect(await page.locator('.react-flow__edge').count()).toBe(0);
    await expect.poll(async () => (await savedDocument(page)).document.canvasDisplay, { timeout: 5_000 })
      .toMatchObject({ columns: false, relationships: false, tableComments: true });
  });
}, 60_000);

it('uses canvas visibility for image exports and allows per-export overrides', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    const document = structuredClone(sampleDocument);
    document.canvasDisplay = { columns: false, groups: false, notes: false, relationships: false };
    await openEditor(page, origin, document);
    await openExport(page, '이미지');
    const dialog = page.getByRole('dialog', { name: '이미지 내보내기' });
    const columns = dialog.getByLabel('컬럼 표시');
    const options = ['메모 포함', '그룹 포함', '관계선 포함'].map(name => dialog.getByLabel(name));
    expect(await columns.inputValue()).toBe('collapsed');
    for (const option of options) expect(await option.isChecked()).toBe(false);
    await dialog.getByLabel('이미지 형식').selectOption('svg');
    async function previewSvg() {
      await action(page, '출력 미리보기').click();
      await action(page, 'SVG 다운로드').waitFor();
      return dialog.getByRole('img').evaluate(async node => {
        const markup = await fetch((node as HTMLImageElement).src).then(response => response.text());
        const svg = new DOMParser().parseFromString(markup, 'image/svg+xml');
        const labels = Array.from(svg.querySelectorAll('text'));
        const relationshipLabels = labels.filter(label => /^(비)?식별 관계 · | · 논리 · /.test(label.textContent ?? ''));
        const rect = (element: Element) => {
          const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(element.getAttribute(name)));
          return { x, y, right: x + width, bottom: y + height };
        };
        const occupied = Array.from(svg.querySelectorAll('rect[stroke="#c9d1df"], rect[stroke="#e2c68c"]'), rect);
        const coveredLabels: (string | null)[] = [];
        for (const label of relationshipLabels) {
          const box = rect(label.previousElementSibling!);
          if (occupied.some(other => box.x < other.right && other.x < box.right && box.y < other.bottom && other.y < box.bottom)) {
            coveredLabels.push(label.textContent);
          }
          occupied.push(box);
        }
        return { text: labels.map(label => label.textContent), edges: svg.querySelectorAll('polyline').length,
          relationshipLabels: relationshipLabels.length, coveredLabels };
      });
    }
    const hidden = await previewSvg();
    expect(hidden.text).toContain('order_items');
    expect(hidden.text).not.toContain('quantity');
    expect(hidden.text).not.toContain(document.views[0].notes[0].text);
    expect(hidden.text).not.toContain(document.views[0].groups[0].name);
    expect(hidden.edges).toBe(0);

    await columns.selectOption('view');
    for (const option of options) await option.check();
    const visible = await previewSvg();
    expect(visible.text).toEqual(expect.arrayContaining([
      'quantity', document.views[0].notes[0].text, document.views[0].groups[0].name, '고객별 상품 집계 · 논리 · N:M',
    ]));
    expect(visible.edges).toBe(4);
    expect(visible.relationshipLabels).toBe(4);
    expect(visible.coveredLabels).toEqual([]);
    await dialog.getByRole('button', { name: '닫기' }).click();
    expect(await page.locator('.canvas-column, .note-text, .react-flow__edge').count()).toBe(0);
  });
});

it('shows persisted NULL and NOT NULL badges independently of key badges', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const document = structuredClone(sampleDocument);
    const column = document.catalog.columns.find(item => item.id === 'product-name')!;
    column.physicalName = 'external_customer_subscription_reference_id';
    column.nullable = true;
    await openEditor(page, origin, document);

    const products = tableOnCanvas(page, 'products');
    const nullable = products.locator('.canvas-column').filter({ hasText: column.physicalName });
    const primary = products.locator('.canvas-column').filter({ has: page.getByText('id', { exact: true }) });
    const width = () => products.evaluate(node => (node as HTMLElement).offsetWidth);
    const initialWidth = await width();
    expect(await products.getByText(/^(NOT )?NULL$/).count()).toBe(0);
    await primary.getByText('PK', { exact: true }).waitFor();

    const options = page.getByRole('dialog', { name: 'ERD 표시 옵션' });
    const nullability = options.getByRole('checkbox', { name: 'NULL 허용 여부', exact: true });
    await action(page, 'ERD 표시 옵션').click();
    expect(await nullability.isChecked()).toBe(false);
    await nullability.check();
    await options.getByRole('checkbox', { name: 'PK·FK·UNIQUE 배지' }).uncheck();
    await action(page, '표시 옵션 적용').click();
    await nullable.getByText('NULL', { exact: true }).waitFor();
    await primary.getByText('NOT NULL', { exact: true }).waitFor();
    expect(await primary.getByText('PK', { exact: true }).count()).toBe(0);
    expect(await width()).toBeGreaterThan(initialWidth);
    expect(await nullable.locator('.canvas-name-text').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect.poll(async () => (await savedDocument(page)).document.canvasDisplay, { timeout: 5_000 })
      .toMatchObject({ columnNullability: true, columnBadges: false });

    await page.reload();
    await nullable.getByText('NULL', { exact: true }).waitFor();
    await primary.getByText('NOT NULL', { exact: true }).waitFor();
    await action(page, 'ERD 표시 옵션').click();
    await nullability.uncheck();
    await action(page, '표시 옵션 적용').click();
    await nullable.getByText('NULL', { exact: true }).waitFor({ state: 'detached' });
    await primary.getByText('NOT NULL', { exact: true }).waitFor({ state: 'detached' });
  });
}, 60_000);

it('aligns column metadata, restores automatic width, and moves only overlapping cards', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const document = structuredClone(sampleDocument);
    const table = document.catalog.tables.find(item => item.id === 'orders')!;
    table.physicalName = 'customer_subscription_notification_settings';
    const column = document.catalog.columns.find(item => item.id === 'order-user-id')!;
    column.physicalName = 'external_customer_subscription_reference_id';
    document.canvasDisplay = { columnNullability: true };
    await openEditor(page, origin, document);

    const card = page.locator('[data-id="overview-orders"] .canvas-table');
    const items = page.locator('[data-id="overview-items"] .canvas-table');
    const cols = card.locator('.canvas-column');
    const longName = card.getByRole('button', { name: column.physicalName + ' 이름 편집', exact: true });
    const cardWidth = () => card.evaluate(node => (node as HTMLElement).offsetWidth);
    const measured = async () => page.locator('.canvas-table').evaluateAll(cards => cards.map(card => {
      const bounds = card.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
    }));
    expect(await cardWidth()).toBe(240);
    expect(await longName.evaluate(node => node.scrollWidth <= node.clientWidth && (node as HTMLElement).offsetHeight > 25)).toBe(true);
    const nameBottom = (await longName.boundingBox())!;
    expect((await cols.first().locator('.column-badges').boundingBox())!.y).toBeGreaterThanOrEqual(nameBottom.y + nameBottom.height);
    const typePositions = () => cols.locator('.canvas-type-text').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().x)));
    expect(new Set(await typePositions()).size).toBe(1);

    await card.locator(':scope > strong > svg').first().click();
    await tab(page, '이름·배치').click();
    await inspector(page).getByRole('button', { name: '자동 너비로 되돌리기' }).click();
    await expect.poll(cardWidth).toBeGreaterThan(300);
    expect(new Set(await typePositions()).size).toBe(1);
    const settle = action(page, '겹친 카드 정리');
    await settle.waitFor();
    const expanded = (await card.boundingBox())!;
    expect(expanded.x + expanded.width).toBeGreaterThan((await items.boundingBox())!.x);
    await expect.poll(async () => (await savedDocument(page)).document.views[0].instances.find(item => item.id === 'overview-orders')!.size,
      { timeout: 5_000 }).toBeUndefined();

    await settle.click();
    await settle.waitFor({ state: 'detached' });
    await expect.poll(async () => (await savedDocument(page)).revision, { timeout: 5_000 }).toBe(3);
    const view = (await savedDocument(page)).document.views[0];
    const original = document.views[0];
    expect(view.instances.filter(item => ['overview-users', 'overview-products'].includes(item.id)))
      .toEqual(original.instances.filter(item => ['overview-users', 'overview-products'].includes(item.id)));
    expect(view.notes).toEqual(original.notes);
    const moved = view.instances.find(item => item.id === 'overview-items')!;
    const group = view.groups.find(item => item.id === moved.groupId)!;
    const itemWidth = await items.evaluate(node => (node as HTMLElement).offsetWidth);
    expect(group.x + group.size!.width).toBeGreaterThanOrEqual(moved.x + itemWidth);
    const boxes = await measured();
    expect(boxes.some((a, index) => boxes.slice(index + 1).some(b => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y))).toBe(false);

    await action(page, '실행 취소').click();
    await settle.waitFor();
    expect(await cardWidth()).toBeGreaterThan(300);
  });
}, 60_000);

it('folds table columns from the card and reveals only connected handles while idle', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const orders = page.locator('[data-id="overview-orders"] .canvas-table');
    const products = page.locator('[data-id="overview-products"] .canvas-table');
    const unused = products.getByLabel('name 연결점', { exact: true });
    const opacity = () => unused.evaluate(node => Number(getComputedStyle(node).opacity));
    const connected = orders.locator('.connected-handle').first();
    expect(await connected.evaluate(node => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0);
    expect(await opacity()).toBe(0);
    await products.hover();
    expect(await opacity()).toBe(1);
    await page.mouse.move(6, 6);
    expect(await opacity()).toBe(0);
    await action(page, '관계 연결').click();
    await action(page, '논리 관계').click();
    expect(await opacity()).toBe(1);
    await page.getByRole('button', { name: '취소', exact: true }).click();

    await orders.locator(':scope > strong > svg').first().click();
    const names = () => orders.locator('.canvas-name-text').allTextContents();
    await orders.getByRole('button', { name: 'number 순서 이동' }).dragTo(
      orders.locator('.canvas-column').filter({ hasText: 'user_id' }), { targetPosition: { x: 100, y: 4 } });
    await expect.poll(names).toEqual(['number', 'user_id']);
    await action(page, '실행 취소').click();
    await expect.poll(names).toEqual(['user_id', 'number']);

    const fold = orders.getByRole('button', { name: 'orders 컬럼 접기 (2개)' });
    const expand = orders.getByRole('button', { name: 'orders 컬럼 펼치기 (2개)' });
    expect(await fold.getAttribute('aria-expanded')).toBe('true');
    await fold.click();
    await orders.locator('.canvas-column').first().waitFor({ state: 'detached' });
    expect(await expand.getAttribute('aria-expanded')).toBe('false');
    expect(await orders.locator('.table-handle.connected-handle').count()).toBeGreaterThan(0);
    await expect.poll(async () => (await savedDocument(page)).document.views[0].instances[0].collapsed, { timeout: 5_000 }).toBe(true);
    await page.reload();
    await expand.click();
    await expect.poll(() => orders.locator('.canvas-column').count()).toBe(2);
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

    await action(page, '이름순 재배치').click();
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
    await inspector(page).getByRole('heading', { name: '현재 다이어그램 배치' }).waitFor();
    await inspector(page).getByRole('button', { name: '현재 다이어그램에서 제거' }).waitFor();
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

it('sets independent colors for a group and a note and restores the default color', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const group = page.locator('[data-id="sales"]');
    const note = page.locator('[data-id="overview-note"]');
    const color = inspector(page).getByLabel('사용자 지정 색상', { exact: true });
    const defaultColor = inspector(page).getByRole('radio', { name: '기본 색상', exact: true });
    const border = (node: typeof group) => node.evaluate(element => getComputedStyle(element).borderTopColor);
    const groupDefault = await border(group);

    await group.locator('.group-name').click();
    expect(await defaultColor.isChecked()).toBe(true);
    await color.fill('#006f92');
    expect(await inspector(page).getByRole('radio', { name: '사용자 지정', exact: true }).isChecked()).toBe(true);
    await action(page, '그룹 적용').click();
    await expect.poll(() => border(group)).toBe('rgb(0, 111, 146)');

    await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
    await note.locator('.note-text').click();
    await color.fill('#8640b0');
    await action(page, '메모 적용').click();
    await expect.poll(() => border(note)).toBe('rgb(134, 64, 176)');
    await expect.poll(async () => (await savedDocument(page)).document.views[0].notes[0].color, { timeout: 5_000 }).toBe('#8640b0');
    await page.reload();
    expect(await border(group)).toBe('rgb(0, 111, 146)');
    expect(await border(note)).toBe('rgb(134, 64, 176)');

    await group.locator('.group-name').click();
    expect(await color.inputValue()).toBe('#006f92');
    await defaultColor.check();
    await action(page, '그룹 적용').click();
    await expect.poll(() => border(group)).toBe(groupDefault);
    expect(await border(note)).toBe('rgb(134, 64, 176)');
    await expect.poll(async () => (await savedDocument(page)).document.views[0].groups[0].color, { timeout: 5_000 }).toBeUndefined();
    await action(page, '실행 취소').click();
    await expect.poll(() => border(group)).toBe('rgb(0, 111, 146)');
  });
}, 60_000);

it('resizes a group on the canvas without moving its members and undoes a drag in one step', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const group = page.locator('[data-id="sales"]');
    const before = sampleDocument.views[0];
    const savedView = async () => (await savedDocument(page)).document.views[0];
    const dimensions = () => group.evaluate(node => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
    const resize = async (corner: string, dx: number, dy: number) => {
      const handle = group.locator('.canvas-group-resize-handle' + corner);
      await handle.waitFor();
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 6 });
      await page.mouse.up();
    };
    await group.locator('.group-name').click();
    await resize('.bottom.right', 56, 45);
    await expect.poll(async () => (await savedView()).groups[0].size?.width, { timeout: 5_000 }).toBeGreaterThan(before.groups[0].size!.width);
    const expanded = (await savedView()).groups[0];
    expect(expanded.size!.height).toBeGreaterThan(before.groups[0].size!.height);
    expect({ x: expanded.x, y: expanded.y }).toEqual({ x: before.groups[0].x, y: before.groups[0].y });
    expect(await dimensions()).toEqual(expanded.size);

    await resize('.top.left', 35, 28);
    await expect.poll(async () => (await savedView()).groups[0].x, { timeout: 5_000 }).toBeGreaterThan(expanded.x);
    const narrowed = await savedView();
    expect(narrowed.groups[0].y).toBeGreaterThan(expanded.y);
    expect(narrowed.groups[0].size!.width).toBeLessThan(expanded.size!.width);
    expect(narrowed.groups[0].size!.height).toBeLessThan(expanded.size!.height);
    expect(narrowed.instances).toEqual(before.instances);
    expect(narrowed.notes).toEqual(before.notes);

    await action(page, '실행 취소').click();
    await expect.poll(async () => (await savedView()).groups[0], { timeout: 5_000 }).toEqual(expanded);
    await page.reload();
    expect(await dimensions()).toEqual(expanded.size);
  });
}, 60_000);

it('edits group and note text and colors directly on the canvas', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const group = page.locator('[data-id="sales"]');
    const note = page.locator('[data-id="overview-note"]');
    const groupEditor = page.getByRole('form', { name: '그룹 편집' });
    const noteEditor = page.getByRole('form', { name: '메모 편집' });

    await group.locator('.group-name').dblclick();
    const groupName = groupEditor.getByLabel('그룹 이름');
    expect(await groupName.evaluate(element => element === document.activeElement)).toBe(true);
    await groupName.fill('배송 관리');
    await groupEditor.getByLabel('사용자 지정 색상').fill('#006f92');
    await groupName.press('Enter');
    await groupEditor.waitFor({ state: 'detached' });
    await group.getByText('배송 관리', { exact: true }).waitFor();

    await note.locator('.note-text').click();
    await note.getByRole('button', { name: '메모 편집', exact: true }).press('Enter');
    const noteText = noteEditor.getByLabel('메모 텍스트');
    await noteText.fill('취소할 내용');
    await noteText.press('Escape');
    await noteEditor.waitFor({ state: 'detached' });
    await note.getByText(sampleDocument.views[0].notes[0].text, { exact: true }).waitFor();

    await note.locator('.note-text').dblclick();
    const content = '배송 담당자 확인\n다음 배포에 반영';
    await noteText.fill(content);
    await noteEditor.getByLabel('사용자 지정 색상').fill('#8640b0');
    await noteText.press('Control+Enter');
    await noteEditor.waitFor({ state: 'detached' });
    await expect.poll(async () => (await savedDocument(page)).document.views[0].notes[0].color, { timeout: 5_000 }).toBe('#8640b0');
    const saved = (await savedDocument(page)).document.views[0];
    expect(saved.groups[0]).toEqual({ ...sampleDocument.views[0].groups[0], name: '배송 관리', color: '#006f92' });
    expect(saved.notes[0]).toEqual({ ...sampleDocument.views[0].notes[0], text: content, color: '#8640b0' });
    await page.reload();
    await group.getByText('배송 관리', { exact: true }).waitFor();
    expect(await note.locator('.note-text').textContent()).toBe(content);
  });
}, 60_000);

it('resizes and remembers both desktop editor panels and resets each width independently', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    await openEditor(page, origin);
    const schemaDivider = page.getByRole('separator', { name: '스키마 너비 조절' });
    const inspectorDivider = page.getByRole('separator', { name: '속성 너비 조절' });
    const canvas = page.getByRole('region', { name: '다이어그램' });
    const width = async (element: typeof schemaDivider) => (await element.boundingBox())!.width;
    const drag = async (divider: typeof schemaDivider, delta: number) => {
      const box = (await divider.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + delta, y, { steps: 6 });
      await page.mouse.up();
    };
    const schemaDefault = await width(nav(page));
    const inspectorDefault = await width(inspector(page));
    await drag(schemaDivider, 110);
    await expect.poll(() => width(nav(page))).toBe(schemaDefault + 110);
    expect(await width(inspector(page))).toBe(inspectorDefault);
    await drag(inspectorDivider, -130);
    await expect.poll(() => width(inspector(page))).toBe(inspectorDefault + 130);
    expect(await width(nav(page))).toBe(schemaDefault + 110);

    await nav(page).getByRole('button', { name: '스키마 접기' }).click();
    await schemaDivider.waitFor({ state: 'detached' });
    expect(await width(nav(page))).toBe(42);
    await nav(page).getByRole('button', { name: '스키마 펼치기' }).click();
    await expect.poll(() => width(nav(page))).toBe(schemaDefault + 110);

    await page.reload();
    await expect.poll(() => width(nav(page))).toBe(schemaDefault + 110);
    expect(await width(inspector(page))).toBe(inspectorDefault + 130);
    await page.setViewportSize({ width: 850, height: 850 });
    await expect.poll(() => width(nav(page))).toBeLessThan(schemaDefault + 110);
    expect(await width(inspector(page))).toBeLessThan(inspectorDefault + 130);
    expect(await width(canvas)).toBeGreaterThanOrEqual(360);
    await page.setViewportSize({ width: 760, height: 850 });
    await schemaDivider.waitFor({ state: 'hidden' });
    await inspectorDivider.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1280, height: 850 });
    await expect.poll(() => width(inspector(page))).toBe(inspectorDefault + 130);
    expect(await width(nav(page))).toBe(schemaDefault + 110);

    await page.setViewportSize({ width: 850, height: 850 });
    await expect.poll(() => width(inspector(page))).toBeLessThan(inspectorDefault + 130);
    const adjustedInspector = await width(inspector(page)) - 20;
    await drag(inspectorDivider, 20);
    await expect.poll(() => width(inspector(page))).toBe(adjustedInspector);
    await page.setViewportSize({ width: 1280, height: 850 });
    await expect.poll(() => width(nav(page))).toBe(schemaDefault + 110);

    await schemaDivider.dblclick();
    await expect.poll(() => width(nav(page))).toBe(schemaDefault);
    expect(await width(inspector(page))).toBe(adjustedInspector);
    await inspectorDivider.dblclick();
    await expect.poll(() => width(inspector(page))).toBe(inspectorDefault);
    await inspectorDivider.press('Shift+ArrowLeft');
    await expect.poll(() => width(inspector(page))).toBe(inspectorDefault + 40);
    await inspectorDivider.press('Enter');
    await expect.poll(() => width(inspector(page))).toBe(inspectorDefault);
    await page.reload();
    await expect.poll(() => width(nav(page))).toBe(schemaDefault);
    expect(await width(inspector(page))).toBe(inspectorDefault);
    expect((await savedDocument(page)).revision).toBe(1);
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

    await action(page, '다이어그램 설정').click();
    await action(page, '다이어그램 복제').click();
    await nav(page).getByRole('button', { name: 'parents', exact: true }).click();
    await tab(page, '이름·배치').click();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('parent_records');
    await action(page, '테이블 적용').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await action(page, '기본 다이어그램').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 다이어그램 복제').click();
    await nav(page).getByRole('button', { name: 'parent_records', exact: true }).click();
    await tab(page, '이름·배치').click();
    await action(page, '현재 다이어그램에서 제거').click();
    await tableOnCanvas(page, 'parent_records').waitFor({ state: 'detached' });
    expect(await nav(page).getByRole('button', { name: 'parent_records', exact: true }).count()).toBe(1);
    await action(page, '기본 다이어그램').click();
    await tableOnCanvas(page, 'parent_records').waitFor();
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await page.getByRole('heading', { name: '물류', exact: true }).waitFor();
    await page.locator('.fk-edge').waitFor();
    await action(page, '기본 다이어그램 복제').click();
    await tableOnCanvas(page, 'children').waitFor();
    expect(await tableOnCanvas(page, 'parent_records').count()).toBe(0);

    await action(page, '기본 다이어그램').click();
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
    expect(await inspector(page).getByRole('list', { name: '확인할 항목' }).count()).toBe(0);
    await action(page, '실행 취소').click();
    await orderNumber.waitFor();
    await expect.poll(() => foreignKeys.count()).toBe(2);
    expect(await inspector(page).getByRole('list', { name: '확인할 항목' }).count()).toBe(0);
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

    await action(page, '스키마 추가').click();
    await field('물리명').fill('stock');
    await action(page, '스키마 만들기').click();
    await field('물리명').fill('inventory');
    await field('설명').fill('Inventory data');
    await action(page, '스키마 적용').click();

    const publicSection = nav(page).locator('.schema-section').filter({
      has: page.getByRole('button', { name: 'public', exact: true }),
    });
    await publicSection.getByRole('button', { name: '테이블 추가', exact: true }).click();
    await field('물리명').fill('parts');
    await action(page, '테이블 만들기').click();
    await tab(page, '이름·배치').click();
    await inspector(page).getByLabel('스키마').selectOption({ label: 'inventory' });
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
    const diagnostics = inspector(page).getByRole('list', { name: '확인할 항목' });
    const unnamed = diagnostics.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'inventory.이름 없는 테이블' }) });
    await unnamed.getByText('물리명을 입력하세요.', { exact: true }).waitFor();
    expect(await diagnostics.getByRole('button', { name: 'inventory.parts', exact: true }).count()).toBe(2);
    expect(await diagnostics.getByText('같은 PostgreSQL 명명 범위에 동일한 물리명이 있습니다.', { exact: true }).count()).toBe(2);
    for (const id of [blank.id, table.id, duplicate.id]) expect(await diagnostics.getByText(id, { exact: true }).count()).toBe(0);
  });
}, 90_000);

it('qualifies same-named FK targets so the intended schema can be selected', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    const document = structuredClone(sampleDocument);
    document.catalog.namespaces.push({ id: 'audit', physicalName: 'audit' });
    document.catalog.tables.push({ id: 'audit-users', namespaceId: 'audit', physicalName: 'users', columnIds: [] });
    await openEditor(page, origin, document);
    await nav(page).getByRole('button', { name: 'orders', exact: true }).click();
    await tab(page, '제약').click();
    await action(page, '외래 키 추가').click();
    const targets = page.getByLabel('참조 테이블');
    expect(await targets.locator('option').allTextContents()).toEqual([
      '테이블 선택', 'public.users', 'orders', 'order_items', 'products', 'audit.users',
    ]);
    await targets.selectOption({ label: 'audit.users' });
    expect(await targets.inputValue()).toBe('audit-users');
  });
});

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
    await inspector(page).getByLabel('카디널리티').selectOption('many-to-many');
    await action(page, '논리 관계 적용').click();
    await action(page, '상품과 고객').click();
    expect(await inspector(page).getByLabel('카디널리티').inputValue()).toBe('many-to-many');
    await page.locator('.logical-edge').getByText('상품과 고객 · 논리 · N:M', { exact: true }).waitFor();
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

    await action(page, '다이어그램 추가').click();
    await page.getByLabel('새 다이어그램 이름').fill('작업용');
    await action(page, '다이어그램 만들기').click();
    await action(page, '다이어그램 설정').click();
    await page.getByRole('dialog', { name: '다이어그램 설정' }).getByLabel('다이어그램 이름', { exact: true }).fill('작업용 상세');
    await action(page, '다이어그램 이름 적용').click();
    await workspace.getByRole('heading', { name: '작업용 상세' }).waitFor();
    for (const name of ['users', 'orders']) {
      await nav(page).getByRole('button', { name, exact: true }).click();
      await tab(page, '이름·배치').click();
      await action(page, '현재 다이어그램에 배치').click();
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
    await action(page, '다이어그램 설정').click();
    await action(page, '다이어그램 복제').click();
    await waitSaved(page);
    const copy = (await savedDocument(page)).document.views.find(view => view.name === '작업용 상세 복제');
    if (!copy) throw new Error('Missing the cloned view.');
    expect(copy.groups[0]).toMatchObject({ name: '배송 그룹' });
    expect(copy.groups[0].id).not.toBe(original.groups[0].id);
    expect(copy.notes[0]).toMatchObject({ text: memo, groupId: copy.groups[0].id });
    expect(copy.notes[0].id).not.toBe(original.notes[0].id);
    expect(copy.instances.map(item => item.tableId)).toEqual(original.instances.map(item => item.tableId));
    expect(copy.instances.find(item => item.tableId === 'orders')).toMatchObject({ groupId: copy.groups[0].id, collapsed: true });

    await action(page, '다이어그램 설정').click();
    page.once('dialog', dialog => dialog.accept());
    await action(page, '다이어그램 삭제').click();
    await nav(page).getByRole('button', { name: '작업용 상세 복제', exact: true }).waitFor({ state: 'detached' });
    await action(page, '작업용 상세').click();
    await tableOnCanvas(page, '주문').waitFor();
    await action(page, '주문 전체').click();
    await tableOnCanvas(page, 'orders').waitFor();
  });
}, 90_000);

it('explains a blocked DDL export and opens the affected SQL field for repair', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);
    const fixture = structuredClone(sampleDocument);
    fixture.catalog.indexes[0].keys = [{ kind: 'column', columnId: 'product-name' }];
    const checkId = 'internal-check-fixture';
    fixture.catalog.constraints.push({ id: checkId, tableId: 'products', physicalName: 'products_name_check', kind: 'check',
      expression: { ...fixture.target, sql: "name <> ''", references: ['product-name'], referencesComplete: true } });
    await openEditor(page, origin, fixture);
    const review = inspector(page).getByRole('list', { name: '확인할 항목' });
    expect(await review.count()).toBe(0);
    expect(await inspector(page).getByText('구조 검증 통과', { exact: true }).count()).toBe(0);

    await nav(page).getByRole('button', { name: 'products', exact: true }).click();
    await inspector(page).getByRole('button', { name: 'name', exact: true }).click();
    await inspector(page).getByLabel('물리명', { exact: true }).fill('product_name');
    await action(page, '컬럼 적용').click();
    await waitSaved(page);
    let saved = await savedDocument(page);
    const target = 'public.products.products_name_check · CHECK SQL';
    const advice = '이름이나 스키마 변경의 영향을 받을 수 있는 SQL 식입니다. 참조 이름을 확인하세요.';
    const issue = review.getByRole('button', { name: target, exact: true });
    await issue.waitFor();
    await review.getByText(advice, { exact: true }).waitFor();
    expect(await review.getByText(checkId, { exact: true }).count()).toBe(0);

    const registry = createSqlRegistry();
    const service = new SqlService(registry);
    await page.route('**/api/sql/dialects', route => route.fulfill({ json: registry.profiles() }));
    await page.route('**/api/projects/*/sql/jobs', async route => {
      const { revision, options } = route.request().postDataJSON() as { revision: number; options: GenerateJobOptions };
      expect(revision).toBe(saved.revision);
      const result = await service.generate({ document: saved.document, target: saved.document.target,
        tableIds: options.tableIds, options: { includeComments: options.includeComments } });
      return route.fulfill({ json: {
        id: `generation-${revision}`, kind: 'generate', erdId: fixture.id, revision, options,
        target: fixture.target, adapterVersion: 'test', expiresAt: null, state: result.status === 'generated' ? 'succeeded' : 'failed',
        output: { diagnostics: result.diagnostics, dependencies: [], sql: result.sql },
      } });
    });

    await openExport(page, 'DDL');
    const dialog = page.getByRole('dialog', { name: 'DDL 내보내기' });
    await dialog.getByRole('button', { name: 'SQL 생성', exact: true }).click();
    await dialog.getByText('DDL을 생성하지 못했습니다.', { exact: true }).waitFor();
    const exportIssues = dialog.getByRole('list', { name: '내보내기 진단' });
    await exportIssues.getByText(advice, { exact: true }).waitFor();
    expect(await exportIssues.getByText(checkId, { exact: true }).count()).toBe(0);
    expect(await dialog.getByLabel('SQL 미리보기').count()).toBe(0);
    await exportIssues.getByRole('button', { name: target, exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const field = inspector(page).getByRole('textbox', { name: 'CHECK SQL', exact: true });
    await expect.poll(() => field.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await field.inputValue()).toBe("name <> ''");
    await field.fill("product_name <> ''");
    await action(page, '제약 적용').click();
    await review.waitFor({ state: 'detached' });
    await waitSaved(page);
    saved = await savedDocument(page);

    await openExport(page, 'DDL');
    await dialog.getByRole('button', { name: 'SQL 생성', exact: true }).click();
    expect(await dialog.getByLabel('SQL 미리보기').inputValue()).toContain('products_name_check');
    expect(await dialog.getByRole('alert').count()).toBe(0);
  });
}, 60_000);

it('preserves advanced data and indexed SQL in existing server documents', async () => {
  await withBrowser(async (context, origin) => {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(8_000);

    const legacy = structuredClone(sampleDocument);
    legacy.catalog.enums.push({ id: 'state-type', physicalName: 'state', namespaceId: 'public-schema', values: ['new', 'paid'] });
    legacy.catalog.sequences.push({ id: 'user-seq', physicalName: 'users_seq', namespaceId: 'public-schema', ownedByColumnId: 'user-id' });
    legacy.catalog.columns[0].identity = 'by-default';
    legacy.catalog.columns.find(column => column.id === 'item-quantity')!.default = { ...legacy.target, sql: '1', invalidated: true };
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
    legacyIndex.predicate = { ...expression, sql: "name <> ''" };
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
    const diagnostics = inspector(page).getByRole('list', { name: '확인할 항목' });
    await diagnostics.getByRole('button', { name: 'public.products.products_name_idx · 인덱스 SQL 식 1', exact: true }).click();
    await expect.poll(() => sqlInput.evaluate(element => element === document.activeElement)).toBe(true);
    await diagnostics.getByRole('button', { name: 'public.products.products_name_idx · 부분 인덱스 조건 SQL', exact: true }).click();
    const predicate = inspector(page).getByRole('textbox', { name: '부분 인덱스 조건 SQL', exact: true });
    await expect.poll(() => predicate.evaluate(element => element === document.activeElement)).toBe(true);
    await diagnostics.getByRole('button', { name: 'public.order_items.quantity · DEFAULT SQL', exact: true }).click();
    const defaultSql = inspector(page).getByRole('textbox', { name: 'DEFAULT SQL', exact: true });
    await expect.poll(() => defaultSql.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await diagnostics.getByRole('listitem').count()).toBe(3);
    expect(await diagnostics.getByText(legacyIndex.id, { exact: true }).count()).toBe(0);

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
