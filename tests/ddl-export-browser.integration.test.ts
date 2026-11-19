import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { exportDocument } from '../packages/test-fixtures/src/ddl-export.js';
import { withBrowser } from './support/browser.js';
import { openExport, renameDocument } from './support/editor-ui.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('flushes editor saves, previews dependencies, and downloads UTF-8 DDL for a saved revision', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const webPort = await freePort();
    const { api } = createApi({ pool, auth: { origin: 'http://127.0.0.1:' + webPort, devLogin: true } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async (context, origin) => {
        const page = context.pages()[0] ?? await context.newPage();
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        page.setDefaultTimeout(10_000);
        await page.goto(origin + '/?workspace=1');
        await page.getByRole('button', { name: '개발 계정으로 로그인', exact: true }).click();
        await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
        await page.getByLabel('새 프로젝트 이름').fill('DDL 프로젝트');
        await page.getByRole('button', { name: '프로젝트 생성', exact: true }).click();
        await page.getByRole('heading', { name: 'DDL 프로젝트', exact: true }).waitFor();
        const projectId = new URL(page.url()).searchParams.get('project')!;
        const me = await (await page.request.get('/api/me')).json();
        const header = { origin, 'x-csrf-token': me.csrfToken };
        const path = '/api/projects/' + projectId + '/erds';
        const fixture = exportDocument(randomUUID());
        const create = await page.request.post(path, { headers: header, data: { document: fixture } });
        expect(create.status(), await create.text()).toBe(201);
        const editor = '/?workspace=1&project=' + projectId + '&erd=' + fixture.id;
        await page.goto(editor);
        await page.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
        await renameDocument(page, '한글 내보내기');
        await openExport(page, 'DDL');
        const dialog = page.getByRole('dialog', { name: 'DDL 내보내기' });
        await dialog.getByLabel('내보낼 범위').selectOption('view');
        await dialog.getByRole('button', { name: '의존성 확인' }).click();
        await dialog.getByText('테이블 · 세일즈.select', { exact: true }).waitFor();
        expect(await dialog.getByRole('button', { name: '.sql 다운로드' }).count()).toBe(0);
        await dialog.getByText(/작업 완료 · 원본 리비전 2/).waitFor();
        await dialog.getByRole('button', { name: 'SQL 생성', exact: true }).click();
        const preview = dialog.getByLabel('SQL 미리보기');
        expect(await preview.inputValue()).toContain('CREATE TABLE "세일즈"."select"');
        const sql = await preview.inputValue();
        expect(sql).not.toContain('"public"."unused"');
        await dialog.getByRole('button', { name: 'SQL 복사', exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sql);
        const pending = page.waitForEvent('download');
        await dialog.getByRole('button', { name: '.sql 다운로드', exact: true }).click();
        const downloaded = await pending;
        expect(downloaded.suggestedFilename()).toBe('한글 내보내기-r2.sql');
        expect(await readFile(await downloaded.path(), 'utf8')).toBe(sql);

        await dialog.getByRole('button', { name: '닫기', exact: true }).click();
        await renameDocument(page, '새 편집본');
        await page.getByText('서버 저장됨 · 리비전 3', { exact: true }).waitFor();
        await openExport(page, 'DDL');
        await dialog.getByText(/현재 편집본과 원본 리비전이 다릅니다/).waitFor();
        await dialog.getByRole('button', { name: '닫기', exact: true }).click();

        // The viewer editor holds revision 3, then the server publishes revision 4.
        await pool.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [projectId, me.user.id]);
        await page.reload();
        await page.getByText('읽기 전용 · 리비전 3', { exact: true }).waitFor();
        await pool.query("UPDATE erds SET revision = 4, title = $2, payload = jsonb_set(payload, '{name}', to_jsonb($2::text)) WHERE id = $1",
          [fixture.id, '최신 서버 문서']);
        await openExport(page, 'DDL');
        await dialog.getByRole('button', { name: 'SQL 생성', exact: true }).click();
        await dialog.getByText(/작업 완료 · 원본 리비전 4/).waitFor();
        await dialog.getByRole('button', { name: '.sql 다운로드', exact: true }).waitFor();
        await dialog.getByRole('button', { name: '닫기', exact: true }).click();

        const blocked = structuredClone(fixture);
        blocked.catalog.indexes[1].predicate = { ...blocked.target, sql: 'TRUE' };
        await pool.query('UPDATE erds SET revision = 5, payload = $2 WHERE id = $1', [fixture.id, JSON.stringify(blocked)]);
        await openExport(page, 'DDL');
        await dialog.getByRole('button', { name: '다시 생성', exact: true }).click();
        await dialog.getByText(/작업 실패 · 원본 리비전 5/).waitFor();
        await dialog.getByText(/부분 인덱스와 식 인덱스/).waitFor();
        expect(await dialog.getByRole('button', { name: '.sql 다운로드' }).count()).toBe(0);
      }, { web: webPort, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
}, 90_000);
