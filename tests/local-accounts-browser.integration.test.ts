import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { withBrowser } from './support/browser.js';
import { withPostgres } from './support/postgres.js';
import { freePort } from './support/tcp.js';

it('uses DB-backed accounts and starts at the current user’s projects', async () => {
  await withPostgres(async cluster => {
    const pool = createDatabase(cluster.connectionString);
    await migrate(pool);
    const web = await freePort();
    const origin = 'http://127.0.0.1:' + web;
    const production = readConfig({ NODE_ENV: 'production', ERD_LOCAL_AUTH: '1',
      DATABASE_URL: cluster.connectionString, APP_ORIGIN: 'https://10.10.50.81:9090' });
    expect(production?.auth).toMatchObject({ localAuth: true, devLogin: false });
    const { api } = createApi({ pool, auth: { origin, localAuth: true, devLogin: false } });
    try {
      const address = await api.listen({ host: '127.0.0.1', port: 0 });
      await withBrowser(async (context, base) => {
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(base);
        const version = page.locator('.app-version').getByText(process.env.VITE_HERD_VERSION || 'dev', { exact: true });
        await version.waitFor();
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const password = 'a';
        async function signup(username: string, displayName: string) {
          await button('계정 만들기').click();
          await page.getByLabel('아이디').fill(username);
          await page.getByLabel('표시 이름').fill(displayName);
          await page.getByLabel('비밀번호').fill(password);
          await button('가입하고 로그인').click();
          await page.getByRole('heading', { name: '내가 만든 프로젝트' }).waitFor();
          return (await (await page.request.get('/api/me')).json()).user.id as string;
        }
        async function create(name: string) {
          const created = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.status() === 201);
          await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
          await page.getByLabel('새 프로젝트 이름').fill(name);
          await button('프로젝트 생성').click();
          return (await (await created).json()).id as string;
        }

        const firstId = await signup('First.User', '첫 번째 사용자');
        await page.emulateMedia({ colorScheme: 'light' });
        await button('다크 모드로 전환').click();
        await page.reload();
        await button('라이트 모드로 전환').waitFor();
        expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
        await create('내 설계');
        await page.getByRole('heading', { name: '내 설계', exact: true }).waitFor();
        await button('새 ERD').click();
        await page.getByLabel('ERD 이름').fill('테마 테스트');
        await button('ERD 생성').click();
        await page.getByRole('heading', { name: '테마 테스트', exact: true }).waitFor();
        await version.waitFor();
        expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
        await button('라이트 모드로 전환').click();
        await button('다크 모드로 전환').waitFor();
        expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
        await page.setViewportSize({ width: 390, height: 844 });
        await version.waitFor();
        await button('가져오기').click();
        const importButton = await button('DDL로 테이블 추가').boundingBox();
        expect(importButton && importButton.x >= 0 && importButton.x + importButton.width <= 390).toBe(true);
        await page.keyboard.press('Escape');
        await button('로그아웃').click();
        const secondId = await signup('shared-owner', '두 번째 사용자');
        const sharedId = await create('공유 설계');
        await button('새 ERD').click();
        await page.getByLabel('ERD 이름').fill('공유 ERD');
        await button('ERD 생성').click();
        await page.getByRole('heading', { name: '공유 ERD', exact: true }).waitFor();
        const sharedLink = page.url();
        await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [sharedId, firstId, 'viewer']);
        await button('로그아웃').click();

        const post = (path: string, data: unknown, requestOrigin = origin) => page.request.post('/api/auth/' + path,
          { data, headers: { origin: requestOrigin } });
        expect((await post('register', { username: 'FIRST.USER', password, displayName: '중복' })).status()).toBe(409);
        expect((await post('register', { username: 'new-user', password: '', displayName: '빈 비밀번호' })).status()).toBe(400);
        expect((await post('password', { username: 'first.user', password }, 'https://other.test')).status()).toBe(403);
        const wrong = await post('password', { username: 'first.user', password: 'wrong password' });
        const unknown = await post('password', { username: 'unknown-user', password });
        expect(wrong.status()).toBe(401);
        expect(unknown.status()).toBe(401);
        expect((await wrong.json()).code).toBe((await unknown.json()).code);

        await page.goto(sharedLink);
        await page.getByLabel('아이디').fill('FIRST.USER');
        await page.getByLabel('비밀번호').fill(password);
        await button('로그인').click();
        await page.getByRole('heading', { name: '공유 ERD', exact: true }).waitFor();
        await page.getByText('읽기 전용 · 리비전 1', { exact: true }).waitFor();
        expect(page.url()).toBe(sharedLink);
        await page.goto(base);
        const owned = page.getByRole('region', { name: '프로젝트 목록', exact: true });
        await owned.getByRole('button', { name: '내 설계' }).waitFor();
        expect(await owned.getByRole('button', { name: '공유 설계' }).count()).toBe(0);
        await page.getByRole('region', { name: '공유받은 프로젝트' }).getByRole('button', { name: '공유 설계' }).waitFor();
        expect(await button('관리자').count()).toBe(0);
        await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [firstId]);
        await page.goto(base);
        await owned.getByRole('button', { name: '내 설계' }).waitFor();
        await button('관리자').click();
        await button('사용자 관리').click();
        const management = page.getByRole('dialog', { name: '사용자 관리' });
        await management.getByLabel('사용자 검색').fill('shared-owner');
        await management.getByRole('button', { name: '검색', exact: true }).click();
        const second = management.getByRole('listitem').filter({ hasText: '두 번째 사용자' });
        await second.getByRole('button', { name: '비활성화' }).click();
        await button('비활성화 확인').click();
        await management.getByText(/유일한 활성 소유자/).waitFor();
        await pool.query("UPDATE project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2", [sharedId, firstId]);
        await button('비활성화 확인').click();
        await second.getByText('비활성', { exact: true }).waitFor();
        const disabledLogin = await post('password', { username: 'shared-owner', password });
        expect(disabledLogin.status()).toBe(403);
        expect((await disabledLogin.json()).code).toBe('ACCOUNT_DISABLED');
        await second.getByRole('button', { name: '재활성화' }).click();
        await button('재활성화 확인').click();
        await second.getByText('활성', { exact: true }).waitFor();
        expect(await pool.query('SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL', [secondId]).then(result => result.rowCount)).toBe(1);
        await management.getByRole('button', { name: '닫기' }).click();

        const { rows } = await pool.query<{ username: string; password_salt: Buffer; password_hash: Buffer }>(
          'SELECT username, password_salt, password_hash FROM password_credentials WHERE username = $1', ['first.user']);
        expect(rows).toHaveLength(1);
        expect(rows[0].password_salt).toHaveLength(16);
        expect(rows[0].password_hash).toHaveLength(64);
        expect(rows[0].password_hash).not.toEqual(Buffer.from(password));
        const account = 'account:' + createHash('sha256').update('first.user').digest('hex');
        await pool.query('UPDATE password_attempts SET attempts = 10 WHERE key = $1', [account]);
        expect((await post('password', { username: 'first.user', password })).status()).toBe(429);
      }, { web, api: Number(new URL(address).port) });
    } finally {
      await api.close();
    }
  });
});
