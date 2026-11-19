import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import type { ServerDocument } from '../apps/web/src/project-api.js';
import { withBrowser } from './support/browser.js';
import { renameDocument } from './support/editor-ui.js';
import { mockIdentityProvider } from './support/oidc.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
const status = (page: Page, name: string) => page.getByText(name, { exact: true }).waitFor();

async function createErd(page: Page, name: string) {
  await action(page, '새 ERD').click();
  await page.getByLabel('ERD 이름', { exact: true }).fill(name);
  await action(page, 'ERD 생성').click();
  await heading(page, name);
  await status(page, '서버 저장됨 · 리비전 1');
  return new URL(page.url()).searchParams.get('erd')!;
}

async function rename(page: Page, name: string) {
  await renameDocument(page, name);
  await heading(page, name);
}

async function getErd(page: Page, id: string) {
  const response = await page.request.get('/api/erds/' + id);
  expect(response.ok()).toBe(true);
  return await response.json() as ServerDocument;
}

it('creates and restores server ERDs, preserves later edits across delayed responses, and resolves conflicts and offline recovery', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const webPort = await freePort();
    const provider = await mockIdentityProvider();
    const { api } = createApi({ pool, auth: { origin: 'http://127.0.0.1:' + webPort, devLogin: true, oidc: provider.settings } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async (context, origin) => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(8_000);
        await page.goto(origin);
        await status(page, '브라우저 임시 저장 대기');
        await rename(page, '오프라인 주문 샘플');
        await status(page, '브라우저 저장 완료');
        await page.getByRole('link', { name: '프로젝트', exact: true }).click();
        await action(page, '개발 계정으로 로그인').click();
        await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
        await page.getByLabel('새 프로젝트 이름').fill('주문 프로젝트');
        await action(page, '프로젝트 생성').click();
        await heading(page, '주문 프로젝트');
        await page.getByRole('button', { name: '가져오기', exact: true }).click();
        await action(page, '로컬 복구본 가져오기').click();
        const importDialog = page.getByRole('dialog', { name: '로컬 복구본을 새 ERD로 저장' });
        await importDialog.getByLabel('로컬 복구본').waitFor();
        expect(await importDialog.getByLabel('로컬 복구본').locator('option').allTextContents()).toEqual([expect.stringContaining('오프라인 주문 샘플')]);
        await action(page, '새 ERD로 저장').click();
        await heading(page, '오프라인 주문 샘플');
        const imported = new URL(page.url()).searchParams.get('erd')!;
        expect(imported).not.toBe('shop-sample');
        expect((await getErd(page, imported)).document.catalog.tables).toHaveLength(4);

        await action(page, 'ERD 목록').click();
        const first = await createErd(page, '주문 모델');
        await action(page, 'ERD 목록').click();
        const second = await createErd(page, '정산 모델');
        await action(page, 'ERD 목록').click();
        await page.getByLabel('ERD 검색').fill('주문 모델');
        expect(await action(page, '정산 모델').count()).toBe(0);
        await action(page, '주문 모델').click();
        await heading(page, '주문 모델');

        let commit!: () => void;
        let rejectCommit!: (error: unknown) => void;
        const committed = new Promise<void>((resolve, reject) => { commit = resolve; rejectCommit = reject; });
        let release!: () => void;
        const withheld = new Promise<void>(resolve => { release = resolve; });
        let requests = 0;
        const firstRoute = '**/api/erds/' + first;
        await page.route(firstRoute, async route => {
          if (route.request().method() !== 'PUT' || ++requests !== 1) return route.continue();
          try {
            const response = await route.fetch();
            expect(response.ok(), await response.text()).toBe(true);
            commit();
            await withheld;
            await route.fulfill({ response });
          } catch (error) {
            rejectCommit(error);
            await route.abort();
          }
        });
        try {
          await rename(page, '첫 저장');
          await committed;
          await rename(page, '요청 중 추가 편집');
          await action(page, '테이블 추가').click();
          const inspector = page.getByRole('complementary', { name: '속성' });
          await inspector.getByLabel('물리명', { exact: true }).fill('orders');
          await action(page, '테이블 만들기').click();
          await action(page, '컬럼 추가').click();
          await inspector.getByLabel('물리명', { exact: true }).fill('order_id');
          await action(page, '컬럼 만들기').click();
          await action(page, 'ERD 목록').click();
          await action(page, '정산 모델').click();
          await heading(page, '정산 모델');
        } finally {
          release();
        }
        await expect.poll(async () => (await getErd(page, first)).document.name).toBe('요청 중 추가 편집');
        const edited = await getErd(page, first);
        expect(edited.revision).toBe(3);
        expect(edited.document.catalog.tables[0].physicalName).toBe('orders');
        expect(edited.document.catalog.columns[0].physicalName).toBe('order_id');
        expect((await getErd(page, second)).revision).toBe(1);
        await heading(page, '정산 모델');

        // A different client commits to the original document while this editor holds revision 3.
        await action(page, 'ERD 목록').click();
        await action(page, '요청 중 추가 편집').click();
        await status(page, '서버 저장됨 · 리비전 3');
        const current = await getErd(page, first);
        const me = await (await page.request.get('/api/me')).json();
        const remote = await page.request.put('/api/erds/' + first, {
          headers: { origin, 'x-csrf-token': me.csrfToken },
          data: { baseRevision: current.revision, mutationId: '00000000-0000-4000-8000-000000000004',
            document: { ...current.document, name: '다른 탭 편집' } },
        });
        expect(remote.ok()).toBe(true);
        await rename(page, '내 충돌 편집');
        await status(page, '저장 충돌');
        await action(page, '서버 최신본 확인').click();
        await heading(page, '다른 탭 편집');
        await status(page, '서버 최신본 · 리비전 4');
        await action(page, '내 편집으로 돌아가기').click();
        await heading(page, '내 충돌 편집');
        await action(page, '내 변경을 새 문서로 복제').click();
        await heading(page, '내 충돌 편집 (내 편집)');
        const forked = new URL(page.url()).searchParams.get('erd')!;
        expect(forked).not.toBe(first);
        expect((await getErd(page, first)).document.name).toBe('다른 탭 편집');

        await context.setOffline(true);
        await rename(page, '오프라인 편집');
        await status(page, '오프라인');
        let reconnects = 0;
        const reconnectRoute = '**/api/erds/' + forked;
        await page.route(reconnectRoute, route => route.request().method() === 'PUT' && ++reconnects === 1
          ? route.abort('failed') : route.continue());
        await context.setOffline(false);
        await status(page, '서버 저장됨 · 리비전 2');
        expect(reconnects).toBeGreaterThanOrEqual(2);
        await page.unroute(reconnectRoute);
        await page.reload();
        await heading(page, '오프라인 편집');
        await status(page, '서버 저장됨 · 리비전 2');
        await page.getByRole('complementary', { name: '문서 탐색' }).getByRole('button', { name: 'orders', exact: true }).waitFor();
        expect((await getErd(page, forked)).document.name).toBe('오프라인 편집');

        // Logout while a write cannot reach the server. The next session sees a selectable draft.
        await page.route('**/api/erds/' + forked, route => route.request().method() === 'PUT' ? route.abort('failed') : route.continue());
        await rename(page, '로그아웃 전 편집');
        await status(page, '오프라인');
        await action(page, '로그아웃').click();
        await heading(page, '프로젝트에 로그인');
        await page.unroute('**/api/erds/' + forked);

        // A different signed-in editor can open the same ERD but cannot see the prior account's local draft.
        await action(page, 'OIDC 로그인').click();
        await expect.poll(async () => (await (await page.request.get('/api/me')).json()).user?.displayName).toBe('alice');
        const other = await (await page.request.get('/api/me')).json();
        const project = new URL(page.url()).searchParams.get('project');
        expect(project).toBeTruthy();
        await pool.query("INSERT INTO project_members VALUES ($1, $2, 'editor')", [project, other.user.id]);
        await page.reload();
        await heading(page, '오프라인 편집');
        expect(await page.getByText('브라우저 복구본', { exact: true }).count()).toBe(0);
        await action(page, '로그아웃').click();
        await heading(page, '프로젝트에 로그인');
        await action(page, '개발 계정으로 로그인').click();
        await heading(page, '오프라인 편집');
        await page.getByText('브라우저 복구본', { exact: true }).click();
        await page.getByRole('button', { name: /복구본 열기.*기준 리비전 2/ }).click();
        await heading(page, '로그아웃 전 편집');
        await status(page, '서버 저장됨 · 리비전 3');
        await page.reload();
        await heading(page, '로그아웃 전 편집');
        expect((await getErd(page, forked)).revision).toBe(3);

        await page.route('**/api/erds/' + forked, route => route.request().method() === 'PUT' ? route.abort('failed') : route.continue());
        await rename(page, '오래된 복구본');
        await status(page, '오프라인');
        const latest = await getErd(page, forked);
        const loggedIn = await (await page.request.get('/api/me')).json();
        const savedElsewhere = await page.request.put('/api/erds/' + forked, {
          headers: { origin, 'x-csrf-token': loggedIn.csrfToken },
          data: { baseRevision: latest.revision, mutationId: '00000000-0000-4000-8000-000000000005',
            document: { ...latest.document, name: '새 서버 버전' } },
        });
        expect(savedElsewhere.ok()).toBe(true);
        await page.reload();
        await heading(page, '새 서버 버전');
        await page.getByText('브라우저 복구본', { exact: true }).click();
        await page.getByRole('button', { name: /복구본 열기.*기준 리비전 3/ }).click();
        await heading(page, '오래된 복구본');
        await status(page, '저장 충돌');
        expect((await getErd(page, forked)).document.name).toBe('새 서버 버전');
        page.once('dialog', dialog => void dialog.accept());
        await action(page, '변경 폐기 후 다시 열기').click();
        await heading(page, '새 서버 버전');
        await status(page, '서버 저장됨 · 리비전 4');
      }, { web: webPort, api: Number(new URL(address).port) });
    } finally {
      await api.close();
      await provider.close();
    }
  });
}, 100_000);
