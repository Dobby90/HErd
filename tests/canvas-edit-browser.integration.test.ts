import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sampleDocument } from '@erd/test-fixtures';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import type { ServerDocument } from '../apps/web/src/project-api.js';
import { withBrowser } from './support/browser.js';
import { openExport } from './support/editor-ui.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('edits and arranges the canvas, connects each relation type, and persists valid schema changes', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const { api } = createApi({ pool, auth: { origin: 'http://127.0.0.1:' + web, devLogin: true } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async (context, origin) => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(7_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const card = (name: string) => page.locator('.canvas-table').filter({ has: page.getByText(name, { exact: true }) });
        await page.goto(origin + '/?workspace=1');
        await button('개발 계정으로 로그인').click();
        await button('새 프로젝트').click();
        await page.getByLabel('새 프로젝트 이름').fill('캔버스 편집');
        await button('프로젝트 생성').click();
        await page.getByRole('heading', { name: '캔버스 편집', exact: true }).waitFor();
        const projectId = new URL(page.url()).searchParams.get('project')!;
        const me = await page.request.get('/api/me').then(response => response.json());
        const document = structuredClone(sampleDocument);
        document.id = randomUUID();
        document.name = '운송 모델';
        expect((await page.request.post('/api/projects/' + projectId + '/erds', {
          headers: { origin, 'x-csrf-token': me.csrfToken }, data: { document },
        })).status()).toBe(201);
        await page.goto(origin + '/?workspace=1&project=' + projectId + '&erd=' + document.id);
        await card('products').waitFor();
        const read = async () => await page.request.get('/api/erds/' + document.id)
          .then(response => response.json()) as ServerDocument;
        const blank = page.locator('.react-flow__pane');
        await button('캔버스에 테이블 추가').dragTo(blank, { targetPosition: { x: 28, y: 370 } });
        const tableForm = page.getByRole('form', { name: '새 테이블' });
        await tableForm.getByLabel('물리명').fill('shipments');
        await tableForm.getByLabel('물리명').press('Enter');
        const newColumn = page.getByRole('form', { name: '새 컬럼' });
        await newColumn.getByLabel('물리명').fill('customer_id');
        await newColumn.getByLabel('물리명').press('Tab');
        expect(await newColumn.getByLabel('자료형').evaluate(node => node === window.document.activeElement)).toBe(true);
        await newColumn.getByLabel('자료형').press('Enter');
        await button('shipments 컬럼 추가').click();
        await newColumn.getByLabel('물리명').fill('tracking_code');
        await newColumn.getByLabel('자료형').fill('varchar(40)');
        await newColumn.getByLabel('자료형').press('Enter');
        await button('shipments 이름 편집').dblclick();
        const rename = page.getByRole('form', { name: '테이블 이름 편집' });
        await rename.getByLabel('물리명').fill('shipment_records');
        await rename.getByLabel('물리명').press('Enter');
        const shipment = card('shipment_records');
        await shipment.waitFor();
        await shipment.getByRole('button', { name: 'tracking_code 순서 이동' }).dragTo(
          shipment.locator('.canvas-column').filter({ hasText: 'customer_id' }), { targetPosition: { x: 30, y: 4 } });
        await expect.poll(() => shipment.locator('.canvas-name-text').allTextContents()).toEqual(['tracking_code', 'customer_id']);
        await button('실행 취소').click();
        await expect.poll(() => shipment.locator('.canvas-name-text').allTextContents()).toEqual(['customer_id', 'tracking_code']);
        await button('다시 실행').click();
        await expect.poll(() => shipment.locator('.canvas-name-text').allTextContents()).toEqual(['tracking_code', 'customer_id']);
        await button('tracking_code 이름 편집').dblclick();
        const edit = page.getByRole('form', { name: '컬럼 편집' });
        await edit.getByLabel('물리명').fill('discarded');
        await edit.getByLabel('물리명').press('Escape');
        expect(await shipment.getByRole('button', { name: 'tracking_code 이름 편집' }).count()).toBe(1);

        const connect = async (menu: string, parent: string, child: string) => {
          await button('관계 연결').click();
          await button(menu).click();
          await card(parent).locator('strong').click();
          await card(child).locator('strong').click();
        };
        const fk = page.getByRole('dialog', { name: '외래 키 설정' });
        await connect('비식별 FK', 'users', 'shipment_records');
        await fk.getByLabel(/에 대응할 원본 컬럼/).selectOption({ label: 'customer_id' });
        await button('외래 키 적용').click();
        await fk.waitFor({ state: 'hidden' });
        await connect('식별 FK', 'orders', 'shipment_records');
        await expect.poll(() => fk.locator('select').evaluateAll(nodes =>
          nodes.filter(node => (node as HTMLSelectElement).selectedOptions[0]?.text.startsWith('새 컬럼')).length)).toBe(2);
        await button('외래 키 적용').click();
        await fk.waitFor({ state: 'hidden' });
        await connect('논리 관계', 'products', 'shipment_records');
        const relation = page.getByRole('dialog', { name: '논리 관계 연결' });
        await relation.getByLabel('관계 차수').selectOption('many-to-many');
        await button('논리 관계 적용').click();
        await relation.waitFor({ state: 'hidden' });
        await expect.poll(() => page.locator('.identifying-edge').count()).toBe(4);
        expect(await page.locator('.non-identifying-edge').count()).toBe(1);
        expect(await page.locator('.logical-edge').count()).toBe(2);
        await shipment.getByRole('button', { name: 'integer 자료형 편집', exact: true }).first().dblclick();
        await edit.getByLabel('자료형').fill('text');
        await edit.getByLabel('자료형').press('Enter');
        await edit.getByRole('alert').getByText(/FK 자료형이 호환되지 않습니다/).waitFor();
        await edit.getByLabel('자료형').press('Escape');
        await expect.poll(async () => (await read()).document.relationships.some(item =>
          item.name === 'products → shipment_records' && item.cardinality === 'many-to-many')).toBe(true);
        const saved = (await read()).document;
        const table = saved.catalog.tables.find(table => table.physicalName === 'shipment_records')!;
        const columns = table.columnIds.map(id => saved.catalog.columns.find(column => column.id === id)!);
        expect(columns.map(column => [column.physicalName, column.type.reference])).toMatchObject([
          ['tracking_code', { name: 'varchar' }], ['customer_id', { name: 'integer' }],
          ['orders_user_id', { name: 'integer' }], ['orders_number', { name: 'integer' }],
        ]);
        expect(columns[0].type.arguments).toEqual([40]);
        const keys = saved.catalog.constraints.filter(key => key.tableId === table.id);
        expect(keys.find(key => key.kind === 'pk')).toMatchObject({ columnIds: columns.slice(2).map(column => column.id) });
        expect(keys.filter(key => key.kind === 'fk')).toHaveLength(2);
        expect(saved.relationships.at(-1)).toMatchObject({ sourceTableId: 'products', targetTableId: table.id, cardinality: 'many-to-many' });
        const generated = await page.request.post('/api/projects/' + projectId + '/sql/jobs', {
          headers: { origin, 'x-csrf-token': me.csrfToken },
          data: { kind: 'generate', erdId: document.id, revision: (await read()).revision, mutationId: randomUUID(), options: { tableIds: [table.id] } },
        });
        expect(generated.status()).toBe(202);
        const jobId = (await generated.json()).id;
        const job = () => page.request.get('/api/sql/jobs/' + jobId).then(response => response.json());
        await expect.poll(async () => (await job()).state).toBe('succeeded');
        const sql = (await job()).output.sql;
        expect(sql).toContain('PRIMARY KEY ("orders_user_id", "orders_number")');
        expect(sql).toContain('FOREIGN KEY ("customer_id")');
        expect(sql).toContain('FOREIGN KEY ("orders_user_id", "orders_number")');
        await button('상품 연결').click();
        await page.getByRole('complementary', { name: '문서 탐색' }).getByRole('button', { name: 'shipment_records', exact: true })
          .dragTo(blank, { targetPosition: { x: 28, y: 370 } });
        await card('shipment_records').waitFor();
        await expect.poll(async () => (await read()).document.views[1].instances.some(item => item.tableId === table.id)).toBe(true);
        await page.reload();
        await card('shipment_records').waitFor();
        await button('캔버스에 테이블 추가').click();
        await button('화면 중앙에 추가').click();
        await tableForm.getByLabel('물리명').fill('carriers');
        await tableForm.getByLabel('물리명').press('Enter');
        await newColumn.getByLabel('물리명').fill('id');
        await newColumn.getByLabel('기본키', { exact: true }).check();
        expect(await newColumn.getByLabel('NULL 허용').isDisabled()).toBe(true);
        await newColumn.getByLabel('물리명').press('Enter');
        await expect.poll(async () => {
          const { catalog } = (await read()).document;
          const carrier = catalog.tables.find(item => item.physicalName === 'carriers');
          return catalog.constraints.some(item => item.tableId === carrier?.id && item.kind === 'pk');
        }).toBe(true);
        const mode = page.getByLabel('이름 표시');
        await mode.selectOption({ label: '전체 보기' });
        await page.locator('.react-flow__controls-fitview').click();
        await expect.poll(async () => (await read()).document.views[0].nameDisplay).toBe('both');
        await button('shipment_records 이름 편집').dblclick();
        await rename.getByLabel('논리명').fill('배송 기록');
        await rename.getByLabel('코멘트').fill('물류 작업의 배송 기록');
        await rename.getByLabel('코멘트').press('Control+Enter');
        await shipment.getByText('배송 기록', { exact: true }).waitFor();
        expect(await shipment.getByText('물류 작업의 배송 기록', { exact: true }).count()).toBe(0);
        await button('tracking_code 이름 편집').dblclick();
        await edit.getByLabel('논리명').fill('운송장 번호');
        await edit.getByLabel('코멘트').fill('택배사의 연동 식별자');
        await edit.getByLabel('기본값 (DEFAULT SQL)', { exact: true }).fill("'대기'");
        await edit.getByLabel('기본값 (DEFAULT SQL)', { exact: true }).press('Control+Enter');
        await shipment.getByText('운송장 번호', { exact: true }).waitFor();
        await shipment.getByText("DEFAULT '대기'", { exact: true }).waitFor();
        await expect.poll(async () => (await read()).document.catalog.columns.find(item => item.id === columns[0].id)?.default?.sql)
          .toBe("'대기'");
        const withMetadata = await read();
        expect(withMetadata.document.catalog.columns.find(item => item.id === columns[0].id))
          .toMatchObject({ logicalName: '운송장 번호', description: '택배사의 연동 식별자' });
        const exportMetadata = await page.request.post('/api/projects/' + projectId + '/sql/jobs', {
          headers: { origin, 'x-csrf-token': me.csrfToken },
          data: { kind: 'generate', erdId: document.id, revision: withMetadata.revision, mutationId: randomUUID(), options: { tableIds: [table.id] } },
        });
        expect(exportMetadata.status()).toBe(202);
        const metadataJobId = (await exportMetadata.json()).id;
        const metadataJob = () => page.request.get('/api/sql/jobs/' + metadataJobId).then(response => response.json());
        await expect.poll(async () => (await metadataJob()).state).toBe('succeeded');
        const metadataSql = (await metadataJob()).output.sql;
        expect(metadataSql).toContain("DEFAULT (E'대기')");
        expect(metadataSql).toContain("COMMENT ON TABLE \"public\".\"shipment_records\" IS E'물류 작업의 배송 기록'");
        expect(metadataSql).toContain("COMMENT ON COLUMN \"public\".\"shipment_records\".\"tracking_code\" IS E'택배사의 연동 식별자'");

        await page.reload();
        expect(await mode.inputValue()).toBe('both');
        await shipment.getByText('택배사의 연동 식별자', { exact: true }).waitFor();
        await openExport(page, '이미지');
        const image = page.getByRole('dialog', { name: '뷰 이미지 내보내기' });
        expect(await image.getByLabel('표시할 이름').inputValue()).toBe('both');
        await image.getByLabel('이미지 형식').selectOption('svg');
        await button('출력 미리보기').click();
        const preview = image.getByRole('img', { name: 'ERD 이미지 출력 미리보기' });
        const markup = await preview.evaluate(async element => await (await fetch(element.getAttribute('src')!)).text());
        expect(markup).toContain('shipment_records · 배송 기록');
        expect(markup).toContain('tracking_code · 운송장 번호');
        expect(markup).toContain('택배사의 연동 식별자');
        await image.getByRole('button', { name: '닫기' }).click();

        const viewport = page.locator('.react-flow__viewport');
        const transform = () => viewport.evaluate(node => (node as HTMLElement).style.transform);
        await button('이동 모드').click();
        expect(await button('이동 모드').getAttribute('aria-pressed')).toBe('true');
        const header = await shipment.locator('strong').boundingBox();
        expect(header).not.toBeNull();
        const before = await transform();
        await page.mouse.move(header!.x + 40, header!.y + 12);
        await page.mouse.down();
        await page.mouse.move(header!.x + 100, header!.y - 45, { steps: 6 });
        await page.mouse.up();
        await expect.poll(transform).not.toBe(before);
        expect((await read()).revision).toBe(withMetadata.revision);
        await button('이동 모드').press('v');
        expect(await button('선택 모드').getAttribute('aria-pressed')).toBe('true');
        await page.locator('.react-flow__controls-fitview').click();

        const impact = page.getByRole('dialog', { name: '스키마 삭제 영향' });
        await card('carriers').locator('strong').click();
        await button('carriers 테이블 삭제').click();
        await impact.getByRole('alert').getByText(/shipment_records.tracking_code/).waitFor();
        expect(await impact.getByRole('button', { name: '실제 삭제 확인' }).isDisabled()).toBe(true);
        await impact.getByRole('button', { name: '취소' }).click();
        await shipment.locator('strong').click();
        await button('shipment_records 테이블 삭제').click();
        await impact.getByRole('heading', { name: 'public.shipment_records' }).waitFor();
        await impact.getByRole('heading', { name: '영향받는 뷰 2개' }).waitFor();
        await impact.getByText('논리 관계 1개 삭제', { exact: true }).waitFor();
        expect(await impact.getByText(table.id, { exact: true }).count()).toBe(0);
        await impact.getByRole('button', { name: '실제 삭제 확인' }).click();
        await shipment.waitFor({ state: 'detached' });
        await expect.poll(async () => (await read()).document.views.some(item => item.instances.some(node => node.tableId === table.id))).toBe(false);
        await button('실행 취소').click();
        await shipment.waitFor();
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
}, 90_000);
