import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { exportDocument } from '../packages/test-fixtures/src/ddl-export.js';
import { withBrowser } from './support/browser.js';
import { openExport, renameDocument } from './support/editor-ui.js';
import { mockIdentityProvider } from './support/oidc.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('aligns project and ERD actions and adds an account directly by login ID', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const origin = 'http://127.0.0.1:' + web;
    const { api } = createApi({ pool, auth: { origin, devLogin: true, localAuth: true } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async context => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(8_000);
        const registered = await api.inject({ method: 'POST', url: '/api/auth/register', headers: { origin },
          payload: { displayName: '설계 팀원', username: 'design-user', password: 'fixture-password' } });
        expect(registered.statusCode).toBe(204);
        await page.goto(origin);
        await page.getByRole('button', { name: '개발 계정으로 로그인' }).click();
        await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
        await page.getByLabel('새 프로젝트 이름').fill('팀 프로젝트');
        await page.getByRole('button', { name: '프로젝트 생성' }).click();
        const project = page.getByRole('group', { name: '프로젝트 관리' });
        const erds = page.getByRole('group', { name: 'ERD 작업' });
        const members = project.getByRole('button', { name: '멤버 관리' });
        const settings = project.getByRole('button', { name: '프로젝트 설정' });
        const importErd = erds.getByRole('button', { name: '가져오기' });
        const newErd = erds.getByRole('button', { name: '새 ERD' });
        await newErd.waitFor();
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          const [left, right, before, after] = await Promise.all([members.boundingBox(), settings.boundingBox(),
            importErd.boundingBox(), newErd.boundingBox()]);
          if (!left || !right || !before || !after) throw new Error('Project or ERD actions could not be measured.');
          expect(left.y).toBeCloseTo(right.y, 0);
          expect(left.x + left.width).toBeLessThan(right.x);
          expect(before.y).toBeCloseTo(after.y, 0);
          expect(before.x + before.width).toBeLessThan(after.x);
          expect(after.y).toBeGreaterThan(right.y);
          expect(Math.max(right.x + right.width, after.x + after.width)).toBeLessThanOrEqual(width);
        }
        expect(await page.getByRole('button', { name: '검색 프로필' }).count()).toBe(0);
        await settings.click();
        await page.getByRole('button', { name: '프로젝트 이름 변경' }).waitFor();
        await page.keyboard.press('Escape');
        await newErd.click();
        await page.getByRole('dialog', { name: '새 서버 ERD' }).waitFor();
        await page.keyboard.press('Escape');

        await members.click();
        const dialog = page.getByRole('dialog', { name: '프로젝트 멤버 관리' });
        await dialog.getByRole('button', { name: '멤버 추가', exact: true }).click();
        await dialog.getByLabel('초대할 사용자').fill('DESIGN-USER');
        await dialog.getByRole('button', { name: '사용자 검색' }).click();
        await dialog.getByRole('radio', { name: /설계 팀원.*design-user/ }).check();
        expect(await dialog.getByLabel('추가할 역할').inputValue()).toBe('viewer');
        await dialog.getByRole('button', { name: '프로젝트에 추가' }).click();
        const added = dialog.getByRole('listitem').filter({ hasText: '설계 팀원' });
        await added.getByText('design-user · 조회자').waitFor();
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
});

it('manages members, opens historical diagrams, safely retries restore, and locks a downgraded viewer', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const provider = await mockIdentityProvider();
    const origin = 'http://127.0.0.1:' + web;
    const { api } = createApi({ pool, auth: { origin, devLogin: true, oidc: provider.settings } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async context => {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(12_000);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const heading = (name: string) => page.getByRole('heading', { name, exact: true }).waitFor();
        const status = (name: string) => page.getByText(name, { exact: true }).waitFor();
        const dialog = (name: string) => page.getByRole('dialog', { name });
        const me = () => page.request.get('/api/me').then(response => response.json());
        await page.goto(origin + '/?workspace=1');
        await button('OIDC 로그인').click();
        await heading('내가 만든 프로젝트');
        const alice = (await me()).user;
        const aliceInProject = 'OIDC 사용자 ' + alice.id.slice(0, 8);
        await button('로그아웃').click();
        await button('개발 계정으로 로그인').click();
        await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
        await page.getByLabel('새 프로젝트 이름').fill('팀 ERD');
        await button('프로젝트 생성').click();
        await heading('팀 ERD');
        const projectId = new URL(page.url()).searchParams.get('project')!;
        const members = '/api/projects/' + projectId + '/members';
        await button('멤버 관리').press('Enter');
        const share = dialog('프로젝트 멤버 관리');
        await share.getByText('마지막 활성 소유자', { exact: true }).waitFor();
        expect(await share.getByRole('button', { name: '권한 회수' }).isDisabled()).toBe(true);
        await share.getByRole('button', { name: '멤버 추가', exact: true }).click();
        await share.getByLabel('초대할 사용자').fill(aliceInProject);
        await button('사용자 검색').click();
        await share.getByRole('radio', { name: aliceInProject }).check();
        expect(await share.getByLabel('추가할 역할').inputValue()).toBe('viewer');
        await share.getByLabel('추가할 역할').selectOption('editor');
        await button('프로젝트에 추가').click();
        const aliceRole = share.getByLabel(aliceInProject + ' 역할');
        const saveAliceRole = share.getByRole('listitem').filter({ hasText: aliceInProject }).getByRole('button', { name: '역할 저장' });
        await aliceRole.waitFor();
        expect(await aliceRole.inputValue()).toBe('editor');
        await aliceRole.selectOption('viewer');
        await saveAliceRole.click();
        await expect.poll(async () => (await page.request.get(members).then(response => response.json()))
          .find((member: { id: string }) => member.id === alice.id)?.role).toBe('viewer');
        await aliceRole.selectOption('editor');
        await saveAliceRole.click();
        await expect.poll(async () => (await page.request.get(members).then(response => response.json()))
          .find((member: { id: string }) => member.id === alice.id)?.role).toBe('editor');
        await share.getByText(aliceInProject + ' 님의 새 역할은 편집자입니다.', { exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await share.waitFor({ state: 'hidden' });
        await expect.poll(() => button('멤버 관리').evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);

        const document = { ...exportDocument(randomUUID()), name: '기준 모델' };
        document.views[0].instances[0].x = -400;
        document.views[0].instances[0].y = 200;
        const csrf = (await me()).csrfToken;
        expect((await page.request.post('/api/projects/' + projectId + '/erds', {
          headers: { origin, 'x-csrf-token': csrf }, data: { document },
        })).status()).toBe(201);
        const erd = '/api/erds/' + document.id;
        const editorUrl = origin + '/?workspace=1&project=' + projectId + '&erd=' + document.id;
        await page.goto(editorUrl);
        await heading('기준 모델');
        await button('버전 이력').click();
        const history = dialog('서버 버전 이력');
        await history.getByLabel('스냅샷 설명').fill('첫 설계');
        await button('수동 스냅샷 저장').click();
        await history.getByText('첫 설계', { exact: true }).waitFor();
        await history.getByRole('button', { name: '닫기' }).click();

        const search = page.getByLabel('스키마 및 뷰 검색');
        await search.fill('Region');
        const result = page.getByRole('complementary', { name: '문서 탐색' }).getByRole('button', { name: 'Region', exact: true });
        await result.click();
        await page.locator('.canvas-column.search-match').filter({ hasText: 'Region' }).waitFor();
        expect(await result.locator('mark').textContent()).toBe('Region');
        await button('이름순 그리드 재배치').click();
        const node = page.locator('.react-flow__node[data-id="a-placement"]');
        await expect.poll(() => node.getAttribute('style')).toContain('translate(0px, 0px)');
        await button('문서 제목 변경').click();
        const title = dialog('문서 제목 변경').getByLabel('문서 제목', { exact: true });
        await title.fill('편집한 모델');
        await title.press('Control+z');
        await title.press('Delete');
        expect(await dialog('스키마 삭제 영향').count()).toBe(0);
        expect(await node.getAttribute('style')).toContain('translate(0px, 0px)');
        await dialog('문서 제목 변경').getByRole('button', { name: '입력 취소' }).click();
        await button('실행 취소').click();
        await expect.poll(() => node.getAttribute('style')).toContain('translate(-400px, 200px)');
        await renameDocument(page, '편집한 모델');
        await heading('편집한 모델');

        await button('버전 이력').click();
        await button('수동 저장 · 리비전 1').click();
        await button('과거 버전 열기').click();
        await status('과거 버전 · 읽기 전용 · 리비전 1');
        await heading('기준 모델');
        expect(await button('실행 취소').count()).toBe(0);
        await button('현재 문서로 돌아가기').click();
        await heading('편집한 모델');

        const restoreRoute = '**/api/erds/' + document.id + '/revisions/*/restore';
        let firstBody: unknown;
        let secondBody: unknown;
        await page.route(restoreRoute, async route => {
          if (firstBody) {
            secondBody = route.request().postDataJSON();
            return route.continue();
          }
          firstBody = route.request().postDataJSON();
          const response = await route.fetch();
          if (response.ok()) return route.abort('failed');
          return route.fulfill({ response });
        });
        await button('버전 이력').click();
        await button('수동 저장 · 리비전 1').click();
        await button('이 버전으로 복원').click();
        await button('버전 목록').click();
        expect(firstBody).toBeUndefined();
        await button('수동 저장 · 리비전 1').click();
        await button('이 버전으로 복원').click();
        await button('확인하고 버전 복원').click();
        await button('같은 복원 요청 다시 시도').click();
        await heading('기준 모델');
        await page.getByText(/복원 전 버전은 서버 이력에 저장되었습니다/).waitFor();
        expect(secondBody).toEqual(firstBody);
        expect(await button('실행 취소').isDisabled()).toBe(true);
        await page.unroute(restoreRoute);
        const after = await page.request.get(erd).then(response => response.json());
        expect(after.document).toEqual(document);
        const revisions = await page.request.get(erd + '/revisions').then(response => response.json());
        expect(revisions.snapshots.filter((item: { kind: string }) => item.kind === 'before-restore')).toHaveLength(1);

        // Keep a separate owner session to revoke Alice after observing her live editor.
        const login = await api.inject({ method: 'POST', url: '/api/auth/development', headers: { origin } });
        const cookies = login.headers['set-cookie'];
        const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(';')[0];
        const actor = (await api.inject({ url: '/api/me', headers: { cookie } })).json();
        const headers = { cookie, origin, 'x-csrf-token': actor.csrfToken };
        await button('로그아웃').click();
        await button('OIDC 로그인').click();
        await heading('기준 모델');
        await page.getByRole('button', { name: '가져오기', exact: true }).click();
        await button('DDL로 모델 교체').waitFor();
        expect((await api.inject({ method: 'PATCH', url: members + '/' + alice.id, headers, payload: { role: 'viewer' } })).statusCode).toBe(204);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await status('읽기 전용 · 리비전 ' + after.revision);
        expect(await button('DDL로 모델 교체').count()).toBe(0);
        expect(await button('관계 연결').count()).toBe(0);
        expect(await button('캔버스에 테이블 추가').count()).toBe(0);
        expect(await button('실행 취소').count()).toBe(0);
        expect(await button('이름순 그리드 재배치').count()).toBe(0);
        await button('내보내기').click();
        await button('DDL 내보내기').waitFor();
        await button('내보내기').click();
        await openExport(page, '이미지');
        await dialog('뷰 이미지 내보내기').getByRole('button', { name: '닫기' }).click();
        const canvasNode = page.locator('.react-flow__node[data-id="a-placement"]');
        const box = (await canvasNode.boundingBox())!;
        const position = await canvasNode.evaluate(node => (node as HTMLElement).style.transform);
        await page.mouse.move(box.x + 30, box.y + 12);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + 60, { steps: 8 });
        await page.mouse.up();
        await canvasNode.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Control+z');
        await page.keyboard.press('Delete');
        expect(await canvasNode.evaluate(node => (node as HTMLElement).style.transform)).toBe(position);
        expect(await dialog('스키마 삭제 영향').count()).toBe(0);
        await canvasNode.click();
        await page.getByRole('tab', { name: '설정', exact: true }).click();
        expect(await page.getByRole('complementary', { name: '속성' }).getByLabel('물리명').isDisabled()).toBe(true);
        await button('버전 이력').click();
        expect(await button('수동 스냅샷 저장').count()).toBe(0);
        await button('수동 저장 · 리비전 1').click();
        expect(await button('이 버전으로 복원').count()).toBe(0);
        expect((await api.inject({ method: 'DELETE', url: members + '/' + alice.id, headers })).statusCode).toBe(204);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.getByRole('alert').getByText(/접근 권한이 회수/).waitFor();
        expect(await history.count()).toBe(0);
        expect((await page.request.get(erd)).status()).toBe(404);
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
      await provider.close();
    }
  });
}, 100_000);
