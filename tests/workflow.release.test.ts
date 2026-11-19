import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDatabase } from '../apps/api/src/database.js';
import { withBrowser } from './support/browser.js';
import { openExport, renameDocument } from './support/editor-ui.js';
import { builtApi, migrateBuilt } from './support/built-api.js';
import { mockIdentityProvider } from './support/oidc.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('imports with warnings, edits and downloads SQL, restores a replacement, and recovers after OIDC expires', async () => {
  await withPostgres(async cluster => {
    migrateBuilt(cluster.connectionString);
    const db = createDatabase(cluster.connectionString);
    const web = await freePort();
    const origin = 'http://127.0.0.1:' + web;
    const provider = await mockIdentityProvider();
    const api = await builtApi(cluster.connectionString, origin, {
      OIDC_ISSUER: provider.settings.issuer.href, OIDC_CLIENT_ID: provider.settings.clientId,
      OIDC_CLIENT_SECRET: provider.settings.clientSecret, ERD_DEV_LOGIN: '0',
    });
    try {
      await withBrowser(async context => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(12_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const heading = (name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
        const status = (revision: number) => page.getByText('서버 저장됨 · 리비전 ' + revision, { exact: true }).waitFor();
        await page.goto(origin + '/?workspace=1');
        await button('OIDC 로그인').click();
        await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
        await page.getByLabel('새 프로젝트 이름').fill('물류 모델 프로젝트');
        await button('프로젝트 생성').click();
        await heading('물류 모델 프로젝트');
        await page.getByRole('button', { name: '가져오기', exact: true }).click();
        await button('DDL로 새 ERD 만들기').click();
        const analysis = page.getByRole('dialog', { name: 'DDL로 새 ERD 만들기' });
        await analysis.getByLabel('DDL 입력').fill('CREATE TABLE warehouse (id integer PRIMARY KEY);\n' +
          'CREATE TABLE inventory (id integer PRIMARY KEY, warehouse_id integer REFERENCES warehouse(id), note text);\n' +
          'CREATE VIEW filtered AS SELECT id FROM inventory;');
        await button('DDL 분석').click();
        await analysis.getByRole('heading', { name: '제외할 항목' }).waitFor();
        expect(await button('새 ERD에 적용').isDisabled()).toBe(true);
        await analysis.getByLabel('이 분석의 제외 항목을 확인했습니다.').check();
        await analysis.getByLabel('새 ERD 이름').fill('입고·재고 모델');
        await button('새 ERD에 적용').click();
        await heading('입고·재고 모델');
        await status(1);
        const erdId = new URL(page.url()).searchParams.get('erd');
        const erdPath = '/api/erds/' + erdId;
        const inspector = page.getByRole('complementary', { name: '속성' });
        await button('inventory').click();
        await inspector.getByRole('button', { name: 'note', exact: true }).click();
        const note = "한글 설명 <품질> O'Brien";
        await inspector.getByLabel('설명', { exact: true }).fill(note);
        await button('컬럼 적용').click();
        await status(2);

        await openExport(page, 'DDL');
        await button('SQL 생성').click();
        const [download] = await Promise.all([page.waitForEvent('download'), button('.sql 다운로드').click()]);
        const sql = await readFile(await download.path(), 'utf8');
        expect(sql).toContain('COMMENT ON COLUMN "public"."inventory"."note"');
        expect(sql).toContain("한글 설명 <품질> O''Brien");
        expect(sql).toContain('FOREIGN KEY');
        await page.getByRole('dialog', { name: 'DDL 내보내기' }).getByRole('button', { name: '닫기' }).click();

        await page.getByRole('button', { name: '가져오기', exact: true }).click();
        await button('DDL로 모델 교체').click();
        await page.getByRole('dialog', { name: 'DDL로 모델 교체' }).getByLabel('DDL 입력')
          .fill('CREATE TABLE replacement (id integer PRIMARY KEY);');
        await button('DDL 분석').click();
        await button('확인하고 모델 교체').click();
        await status(3);
        await button('버전 이력').click();
        await button('DDL 교체 전 · 리비전 2').click();
        await button('과거 버전 열기').click();
        await page.getByText('과거 버전 · 읽기 전용 · 리비전 2', { exact: true }).waitFor();
        await button('inventory').waitFor();
        await button('현재 문서로 돌아가기').click();
        await button('버전 이력').click();
        await button('DDL 교체 전 · 리비전 2').click();
        await button('이 버전으로 복원').click();
        await button('확인하고 버전 복원').click();
        await status(4);
        const restored = await page.request.get(erdPath).then(response => response.json());
        expect(restored.document.catalog.columns).toEqual(expect.arrayContaining([expect.objectContaining({ physicalName: 'note', description: note })]));

        const user = await page.request.get('/api/me').then(response => response.json());
        await db.query("UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1", [user.user.id]);
        await renameDocument(page, '재로그인 후 복구된 모델');
        await page.getByRole('dialog', { name: '다시 로그인' }).getByRole('button', { name: 'OIDC 로그인' }).click();
        await heading('입고·재고 모델');
        await page.getByText('브라우저 복구본', { exact: true }).click();
        await page.getByRole('button', { name: /복구본 열기.*기준 리비전 4/ }).click();
        await heading('재로그인 후 복구된 모델');
        await status(5);
        await page.reload();
        await heading('재로그인 후 복구된 모델');
        await status(5);
        expect(provider.exchanges).toBe(2);
        if (process.env.HERD_IMAGE_REVIEW_DIR) {
          const out = process.env.HERD_IMAGE_REVIEW_DIR;
          await mkdir(out, { recursive: true });
          await button('inventory').click();
          await inspector.getByRole('button', { name: 'note', exact: true }).click();
          await page.locator('.react-flow__edge.fk-edge').waitFor();
          await page.screenshot({ path: join(out, 'editor.png') });
        }
      }, { web, api: api.port, production: true });
    } finally {
      await api.close();
      await provider.close();
      await db.end();
    }
  });
});
