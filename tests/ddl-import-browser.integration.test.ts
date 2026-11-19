import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { withBrowser } from './support/browser.js';
import { renameDocument } from './support/editor-ui.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('loads UTF-8 SQL, resets loss confirmation, ignores an older analysis, and applies a replacement at the saved revision', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const { api } = createApi({ pool, auth: { origin: 'http://127.0.0.1:' + web, devLogin: true } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async (context, origin) => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(10_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const heading = (name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
        await page.goto(origin + '/?workspace=1');
        await button('개발 계정으로 로그인').click();
        await page.getByLabel('새 프로젝트 이름').fill('가져오기 프로젝트');
        await button('프로젝트 생성').click();
        await heading('가져오기 프로젝트');
        const projectId = new URL(page.url()).searchParams.get('project')!;
        const newImport = () => page.getByRole('dialog', { name: 'DDL로 새 ERD 만들기' });
        await button('DDL로 새 ERD 만들기').click();
        await newImport().getByLabel('기본 스키마').fill('스키마');
        const marker = '이전_분석';
        const routePath = '**/api/projects/' + projectId + '/sql/jobs';
        let committed!: () => void;
        const submitted = new Promise<void>(resolve => { committed = resolve; });
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        await page.route(routePath, async route => {
          if (route.request().method() !== 'POST' || !route.request().postData()?.includes(marker)) return route.continue();
          const response = await route.fetch();
          committed();
          await held;
          await route.fulfill({ response }).catch(() => undefined);
        });
        try {
          await newImport().getByLabel('DDL 입력').fill('CREATE TABLE "' + marker + '" (id integer);');
          await newImport().getByRole('button', { name: 'DDL 분석' }).click();
          await Promise.race([submitted, new Promise((_, reject) => setTimeout(() => reject(new Error('Initial analysis did not start.')), 8_000))]);
          await newImport().getByRole('button', { name: '닫기', exact: true }).click();
          await button('DDL로 새 ERD 만들기').click();
          const uploaded = `CREATE TABLE "최신 문서" (id integer PRIMARY KEY, note text DEFAULT $$한글; '말'$$);
CREATE VIEW skip_me AS SELECT * FROM "최신 문서";`;
          await newImport().getByLabel('UTF-8 .sql 파일').setInputFiles({ name: 'schema.sql', mimeType: 'application/sql', buffer: Buffer.from(uploaded) });
          await expect.poll(() => newImport().getByLabel('DDL 입력').inputValue()).toBe(uploaded);
          await newImport().getByRole('button', { name: 'DDL 분석' }).click();
          await newImport().getByText('스키마.최신 문서', { exact: true }).waitFor();
          release();
          await newImport().getByRole('heading', { name: '제외할 항목' }).waitFor();
          expect(await newImport().getByText('스키마.' + marker, { exact: true }).count()).toBe(0);
          const confirm = newImport().getByLabel('이 분석의 제외 항목을 확인했습니다.');
          expect(await newImport().getByRole('button', { name: '새 ERD에 적용' }).isDisabled()).toBe(true);
          await confirm.check();
          await newImport().getByLabel('DDL 입력').fill(uploaded.replaceAll('최신 문서', '확정 모델'));
          await newImport().getByRole('button', { name: 'DDL 분석' }).click();
          await newImport().getByText('스키마.확정 모델', { exact: true }).waitFor();
          expect(await confirm.isChecked()).toBe(false);
          await confirm.check();
          await newImport().getByLabel('새 ERD 이름').fill('가져온 문서');
          await newImport().getByRole('button', { name: '새 ERD에 적용' }).click();
          await heading('가져온 문서');
        } finally {
          release();
          await page.unroute(routePath);
        }
        const erdId = new URL(page.url()).searchParams.get('erd')!;
        await page.getByText('서버 저장됨 · 리비전 1', { exact: true }).waitFor();
        const document = () => page.request.get('/api/erds/' + erdId).then(response => response.json());
        expect((await document()).document.catalog.tables[0].physicalName).toBe('확정 모델');
        await renameDocument(page, '교체 전 이름');
        const prepareReplacement = async () => {
          await button('DDL로 모델 교체').click();
          const dialog = page.getByRole('dialog', { name: 'DDL로 모델 교체' });
          expect(await dialog.getByLabel('SQL 대상').isDisabled()).toBe(true);
          await dialog.getByLabel('DDL 입력').fill('CREATE TABLE imported (id integer GENERATED BY DEFAULT AS IDENTITY);');
          await dialog.getByRole('button', { name: 'DDL 분석' }).click();
          await dialog.getByText('public.imported', { exact: true }).waitFor();
          return dialog;
        };
        let dialog = await prepareReplacement();
        await dialog.getByText(/교체 기준 리비전 2/).waitFor();
        const saved = await document();
        const me = await page.request.get('/api/me').then(response => response.json());
        expect((await page.request.put('/api/erds/' + erdId, {
          headers: { origin, 'x-csrf-token': me.csrfToken },
          data: { baseRevision: 2, mutationId: randomUUID(), document: { ...saved.document, name: '다른 탭에서 저장한 문서' } },
        })).ok()).toBe(true);
        await dialog.getByRole('button', { name: '확인하고 모델 교체' }).click();
        await dialog.getByRole('alert').getByText('대상 문서가 변경되었습니다.', { exact: true }).waitFor();
        expect((await document()).document.catalog.tables[0].physicalName).toBe('확정 모델');
        await dialog.getByRole('button', { name: '닫기', exact: true }).click();
        await page.reload();
        await heading('다른 탭에서 저장한 문서');
        dialog = await prepareReplacement();
        await dialog.getByText(/교체 기준 리비전 3/).waitFor();
        await dialog.getByRole('button', { name: '확인하고 모델 교체' }).click();
        await page.getByText('서버 저장됨 · 리비전 4', { exact: true }).waitFor();
        await page.getByText(/교체 전 버전은 서버 이력에 저장되었습니다/).waitFor();
        expect(await button('실행 취소').isDisabled()).toBe(true);
        const updated = await document();
        expect(updated.document.catalog.tables[0].physicalName).toBe('imported');
        expect((await pool.query("SELECT source_revision, payload FROM erd_revisions WHERE erd_id = $1 AND kind = 'before-import'", [erdId])).rows)
          .toMatchObject([{ source_revision: 3, payload: { catalog: { tables: [{ physicalName: '확정 모델' }] } } }]);
        await page.reload();
        await page.getByText('서버 저장됨 · 리비전 4', { exact: true }).waitFor();
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
}, 90_000);
