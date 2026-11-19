import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateDocumentStructure } from '@erd/model';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import type { SnapshotInfo } from '../apps/web/src/project-api.js';
import { exportDocument, exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { withPostgres } from './support/postgres.js';

const origin = 'http://127.0.0.1:5173';

type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(connectionString: string) {
  const db = createDatabase(connectionString);
  await migrate(db);
  const { api } = createApi({ pool: createDatabase(connectionString), auth: { origin, devLogin: false } });
  api.addHook('onSend', (request, reply, _payload, done) => {
    if (request.headers['x-drop-restore-response'] === '1' && reply.statusCode === 200) {
      reply.hijack();
      reply.raw.destroy();
    } else done();
  });

  async function account(name: string, { admin = false, username, subject }: { admin?: boolean; username?: string; subject?: string } = {}) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO users (id, issuer, subject, display_name, is_admin) VALUES ($1,$2,$3,$4,$5)',
      [id, username ? 'urn:herd:password' : 'urn:fixture:accounts', subject ?? id, name, admin]);
    if (username) {
      await db.query('INSERT INTO password_credentials (user_id, username, password_salt, password_hash) VALUES ($1,$2,$3,$4)',
        [id, username, randomBytes(16), randomBytes(64)]);
    }
    await db.query("INSERT INTO sessions VALUES ($1,$2,now() + interval '1 hour')", [createHash('sha256').update(token).digest('hex'), id]);
    const headers = { cookie: 'herd-session=' + token, origin, 'x-csrf-token': createHash('sha256').update('herd:csrf:' + token).digest('hex') };
    const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      api.inject({ method, url, headers, payload });
    return { id, headers, request, get: (url: string) => request('GET', url) };
  }

  async function project(actor: Awaited<ReturnType<typeof account>>, name: string) {
    const response = await actor.request('POST', '/api/projects', { name });
    expect(response.statusCode, response.body).toBe(201);
    return '/api/projects/' + response.json().id;
  }
  async function close() {
    await api.close();
    await db.end();
  }
  return { db, api, account, project, close };
}

async function fixture(run: (context: Fixture) => Promise<void>) {
  await withPostgres(async cluster => {
    const context = await setup(cluster.connectionString);
    try { await run(context); }
    finally { await context.close(); }
  });
}

it('searches and adds active registered accounts without separate search profiles', async () => {
  await fixture(async ({ db, account, project }) => {
    const [owner, first, second, disabled, oidc, nameless, admin] = await Promise.all([
      account('소유자'), account('김', { username: 'team-first' }), account('김', { username: 'team-second' }),
      account('김', { username: 'team-inactive' }), account('OIDC 이름', { subject: 'provider-subject' }),
      account('provider-fallback', { subject: 'provider-fallback' }), account('운영자', { admin: true }),
    ]);
    await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.id]);
    await db.query('UPDATE users SET directory_name = $2, directory_alias = $3 WHERE id = $1', [second.id, '이전 프로필', 'legacy-alias']);
    const members = (await project(owner, '가입 계정 검색')) + '/members';
    const search = (query: string) => owner.get(members + '/candidates?q=' + encodeURIComponent(query));
    const firstAccount = { id: first.id, displayName: '김', username: 'team-first' };
    const secondAccount = { id: second.id, displayName: '김', username: 'team-second' };
    expect((await search(' TEAM-FIRST ')).json()).toEqual({ users: [firstAccount], hasMore: false });
    expect((await search('김')).json()).toEqual({ users: [firstAccount, secondAccount], hasMore: false });
    for (const query of ['legacy-alias', 'provider-subject', 'provider-fallback', '%_']) {
      expect((await search(query)).json()).toEqual({ users: [], hasMore: false });
    }
    expect((await search('OIDC 이름')).json()).toEqual({
      users: [{ id: oidc.id, displayName: 'OIDC 이름', username: null }], hasMore: false,
    });
    expect((await search(nameless.id.slice(0, 8))).json()).toEqual({
      users: [{ id: nameless.id, displayName: 'OIDC 사용자 ' + nameless.id.slice(0, 8), username: null }], hasMore: false,
    });
    expect((await search('')).statusCode).toBe(400);
    expect((await first.get(members + '/candidates?q=team')).statusCode).toBe(404);
    expect((await owner.request('POST', members, { userId: disabled.id, role: 'viewer' })).statusCode).toBe(404);
    const added = await owner.request('POST', members, { userId: first.id, role: 'viewer' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ ...firstAccount, disabled: false, role: 'viewer' });
    expect((await search('team')).json()).toEqual({ users: [secondAccount], hasMore: false });
    expect((await first.get(members + '/candidates?q=team')).statusCode).toBe(403);
    expect((await owner.get('/api/me')).json().user).not.toHaveProperty('directory');
    expect((await owner.request('PATCH', '/api/me/directory', { publicName: '이전 프로필', alias: 'legacy-alias' })).statusCode).toBe(404);
    const adminSearch = await admin.get('/api/admin/users?q=TEAM-SECOND');
    expect(adminSearch.json().users).toMatchObject([secondAccount]);
    expect(adminSearch.json().users[0]).not.toHaveProperty('alias');
  });
});

it('enforces member and document scope, checks live access for old SQL jobs, and serializes last-owner removal', async () => {
  await fixture(async ({ db, account, project }) => {
    const [owner, editor, outsider] = await Promise.all([account('owner'), account('editor'), account('outsider')]);
    const path = await project(owner, '공유 검증');
    const other = await project(outsider, '별도 프로젝트');
    const members = path + '/members';
    const lookup = members + '/candidates?q=ed';
    const invite = (userId: string, role: string) => owner.request('POST', members, { userId, role });
    expect((await owner.get(lookup)).json()).toEqual({ users: [{ id: editor.id, displayName: 'editor', username: null }], hasMore: false });
    expect((await outsider.get(lookup)).statusCode).toBe(404);
    expect((await invite(editor.id, 'editor')).statusCode).toBe(201);
    expect((await invite(editor.id, 'viewer')).json()).toMatchObject({ code: 'ALREADY_A_MEMBER' });
    expect((await owner.get(lookup)).json()).toEqual({ users: [], hasMore: false });
    expect((await editor.get(members)).statusCode).toBe(403);
    expect((await editor.get(lookup)).statusCode).toBe(403);
    expect((await owner.request('PATCH', members + '/' + outsider.id, { role: 'viewer' })).statusCode).toBe(404);
    expect((await owner.request('DELETE', members + '/' + owner.id)).json()).toMatchObject({ code: 'LAST_OWNER' });

    const document = exportDocument(randomUUID());
    const another = exportDocument(randomUUID());
    expect((await owner.request('POST', path + '/erds', { document })).statusCode).toBe(201);
    expect((await outsider.request('POST', other + '/erds', { document: another })).statusCode).toBe(201);
    const erd = '/api/erds/' + document.id;
    const foreign = '/api/erds/' + another.id;
    const made = await owner.request('POST', erd + '/revisions', { baseRevision: 1, description: 'shared' });
    expect(made.statusCode, made.body).toBe(201);
    const version = erd + '/revisions/' + made.json().id;
    const foreignVersion = foreign + '/revisions/' + made.json().id;
    expect((await editor.get(foreign)).statusCode).toBe(404);
    expect((await outsider.get(version)).statusCode).toBe(404);
    expect((await outsider.get(foreignVersion)).json()).toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    expect((await outsider.request('POST', foreignVersion + '/restore', { baseRevision: 1, mutationId: randomUUID() })).statusCode).toBe(404);

    const jobs = path + '/sql/jobs';
    const parse = { kind: 'parse', target: exportTarget, defaultNamespace: 'public', sql: 'CREATE TABLE verified (id integer);' };
    const generate = { kind: 'generate', erdId: document.id, revision: 1 };
    const start = await editor.request('POST', jobs, { ...parse, mutationId: randomUUID() });
    expect(start.statusCode, start.body).toBe(202);
    const parsePath = '/api/sql/jobs/' + start.json().id;
    await expect.poll(async () => (await editor.get(parsePath)).json().state, { timeout: 10_000 }).toBe('succeeded');
    expect((await owner.request('PATCH', members + '/' + editor.id, { role: 'viewer' })).statusCode).toBe(204);
    expect((await editor.get(erd)).statusCode).toBe(200);
    expect((await editor.get(version)).statusCode).toBe(200);
    expect((await editor.request('POST', path + '/erds', { document: exportDocument(randomUUID()) })).statusCode).toBe(403);
    expect((await editor.request('PUT', erd, { baseRevision: 1, mutationId: randomUUID(), document })).statusCode).toBe(403);
    expect((await editor.request('DELETE', erd)).statusCode).toBe(403);
    expect((await editor.request('POST', erd + '/revisions', { baseRevision: 1 })).statusCode).toBe(403);
    expect((await editor.request('POST', version + '/restore', { baseRevision: 1, mutationId: randomUUID() })).statusCode).toBe(403);
    expect((await editor.request('POST', jobs, { ...parse, mutationId: randomUUID() })).statusCode).toBe(403);
    expect((await editor.get(parsePath)).statusCode).toBe(404);
    expect((await editor.request('DELETE', parsePath)).statusCode).toBe(404);
    expect((await editor.request('POST', parsePath + '/apply', { mode: 'create', name: '접근 불가', mutationId: randomUUID() })).statusCode).toBe(403);
    expect((await editor.request('POST', jobs, { ...generate, erdId: another.id, mutationId: randomUUID() })).statusCode).toBe(404);
    const exporting = await editor.request('POST', jobs, { ...generate, mutationId: randomUUID() });
    expect(exporting.statusCode, exporting.body).toBe(202);
    const exportPath = '/api/sql/jobs/' + exporting.json().id;
    await expect.poll(async () => (await editor.get(exportPath)).json().state, { timeout: 10_000 }).toBe('succeeded');

    expect((await owner.request('DELETE', members + '/' + editor.id)).statusCode).toBe(204);
    expect((await editor.get('/api/me')).json().user).toMatchObject({ id: editor.id });
    for (const protectedPath of [path, erd, erd + '/revisions', version, exportPath, parsePath]) {
      expect((await editor.get(protectedPath)).statusCode).toBe(404);
    }
    expect((await invite(editor.id, 'owner')).statusCode).toBe(201);
    const attempts = await Promise.all([
      owner.request('DELETE', members + '/' + owner.id),
      editor.request('PATCH', members + '/' + editor.id, { role: 'viewer' }),
    ]);
    expect(attempts.map(item => item.statusCode).sort()).toEqual([204, 409]);
    expect(attempts.find(item => item.statusCode === 409)?.json()).toMatchObject({ code: 'LAST_OWNER' });
    expect((await db.query("SELECT 1 FROM project_members WHERE project_id = $1 AND role = 'owner'", [path.split('/').at(-1)])).rowCount).toBe(1);
  });
}, 90_000);

it('limits administration to service admins and preserves an active project owner across concurrent changes', async () => {
  await fixture(async ({ db, api, account, project }) => {
    const [admin, owner, other] = await Promise.all([account('admin', { admin: true }), account('owner'), account('co-owner')]);
    const path = await project(owner, '활성 소유자');
    const adminPath = '/api/admin/users';
    const status = adminPath + '/' + owner.id;
    const setDisabled = (disabled: boolean) => admin.request('PATCH', status, { disabled });
    expect((await owner.get(adminPath)).statusCode).toBe(403);
    expect((await admin.get(path)).statusCode).toBe(404);
    expect((await admin.get(adminPath + '?q=owner')).json().users).toHaveLength(2);
    expect((await admin.request('PATCH', adminPath + '/' + admin.id, { disabled: true })).json()).toMatchObject({ code: 'ADMIN_ACCOUNT_PROTECTED' });
    expect((await api.inject({ method: 'PATCH', url: status, headers: { ...admin.headers, origin: 'https://other.invalid' },
      payload: { disabled: true } })).statusCode).toBe(403);
    expect((await setDisabled(true)).json()).toMatchObject({ code: 'LAST_OWNER' });

    const members = path + '/members';
    expect((await owner.request('POST', members, { userId: other.id, role: 'owner' })).statusCode).toBe(201);
    const attempts = await Promise.all([
      setDisabled(true),
      other.request('PATCH', members + '/' + other.id, { role: 'viewer' }),
    ]);
    expect(attempts.map(result => result.statusCode).sort()).toEqual([204, 409]);
    if (attempts[0].statusCode === 409) {
      expect((await owner.request('PATCH', members + '/' + other.id, { role: 'owner' })).statusCode).toBe(204);
      expect((await setDisabled(true)).statusCode).toBe(204);
    }
    expect((await owner.get('/api/me')).json().user).toBe(null);
    expect((await owner.get(path)).statusCode).toBe(401);
    expect((await other.request('DELETE', members + '/' + other.id)).json()).toMatchObject({ code: 'LAST_OWNER' });
    expect((await db.query('SELECT 1 FROM sessions WHERE user_id = $1', [owner.id])).rowCount).toBe(0);
    expect((await setDisabled(false)).statusCode).toBe(204);
    expect((await owner.get(path)).statusCode).toBe(401);
  });
});

it('migrates version payloads, restores atomically through failure and replay, and prunes checkpoints only', async () => {
  await fixture(async ({ db, api, account, project }) => {
    const owner = await account('versions');
    const path = await project(owner, '버전 검증');
    const original = { ...exportDocument(randomUUID()), name: '복원할 원본' };
    const erd = '/api/erds/' + original.id;
    const history = erd + '/revisions';
    const put = (document: typeof original, baseRevision: number) => owner.request('PUT', erd, { document, baseRevision, mutationId: randomUUID() });
    const save = await owner.request('POST', path + '/erds', { document: original });
    expect(save.statusCode).toBe(201);
    const manualBody = { baseRevision: 1, description: '첫 기준', mutationId: randomUUID() };
    const manual = await owner.request('POST', history, manualBody);
    expect(manual.statusCode, manual.body).toBe(201);
    expect(manual.json()).toMatchObject({ kind: 'manual', sourceRevision: 1, author: 'versions', description: '첫 기준' });
    expect((await owner.request('POST', history, manualBody)).json()).toEqual(manual.json());
    const old = { ...original, formatVersion: 0, extensions: undefined };
    await db.query('UPDATE erd_revisions SET payload = $2 WHERE id = $1', [manual.json().id, JSON.stringify(old)]);
    const version = history + '/' + manual.json().id;
    expect((await owner.get(version)).json().document).toEqual(original);
    const edited = { ...original, name: '교체될 현재 모델' };
    expect((await put(edited, 1)).json().revision).toBe(2);
    expect((await put({ ...edited, name: '두 번째 편집' }, 2)).json().revision).toBe(3);
    const current = (await owner.get(erd)).json();
    const checkpoints = () => db.query("SELECT source_revision FROM erd_revisions WHERE erd_id = $1 AND kind = 'checkpoint' ORDER BY source_revision", [original.id]);
    expect((await checkpoints()).rows).toEqual([{ source_revision: 2 }]);
    const snapshotKinds = () => db.query('SELECT kind FROM erd_revisions WHERE erd_id = $1 ORDER BY kind', [original.id]);
    const baseline = (await snapshotKinds()).rows;
    const restore = (baseRevision: number, mutationId = randomUUID()) => owner.request('POST', version + '/restore', { baseRevision, mutationId });
    expect((await restore(1)).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await owner.request('POST', history, { baseRevision: 1 })).statusCode).toBe(409);

    const bad = randomUUID();
    const foreignTarget = { ...original, target: { ...original.target, engineVersion: '18' } };
    await db.query("INSERT INTO erd_revisions (id, erd_id, source_revision, payload, kind, created_by) VALUES ($1,$2,1,$3,'manual',$4)",
      [bad, original.id, JSON.stringify(foreignTarget), owner.id]);
    const invalid = () => owner.request('POST', history + '/' + bad + '/restore', { baseRevision: 3, mutationId: randomUUID() });
    expect((await invalid()).json()).toMatchObject({ code: 'DOCUMENT_TARGET_MISMATCH' });
    await db.query("UPDATE erd_revisions SET payload = jsonb_set(payload, '{id}', to_jsonb(gen_random_uuid())) WHERE id = $1", [bad]);
    expect((await invalid()).json()).toMatchObject({ code: 'UNREADABLE_DOCUMENT' });
    await db.query('DELETE FROM erd_revisions WHERE id = $1', [bad]);

    await db.query("CREATE FUNCTION fail_restore_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$");
    await db.query("CREATE TRIGGER fail_restore_fixture BEFORE UPDATE ON erds FOR EACH ROW WHEN (NEW.title = '복원할 원본') EXECUTE FUNCTION fail_restore_fixture()");
    const mutationId = randomUUID();
    expect((await restore(3, mutationId)).statusCode).toBe(500);
    expect((await owner.get(erd)).json()).toEqual(current);
    expect((await snapshotKinds()).rows).toEqual(baseline);
    await db.query('DROP TRIGGER fail_restore_fixture ON erds');
    const base = await api.listen({ host: '127.0.0.1', port: 0 });
    await expect(fetch(base + version + '/restore', {
      method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json', 'x-drop-restore-response': '1' },
      body: JSON.stringify({ baseRevision: 3, mutationId }),
    })).rejects.toThrow();
    expect((await restore(3, mutationId)).json().revision).toBe(4);
    expect((await restore(4, mutationId)).json()).toMatchObject({ code: 'MUTATION_MISMATCH' });
    const restored = (await owner.get(erd)).json();
    expect(restored).toMatchObject({ revision: 4, document: original });
    expect(validateDocumentStructure(restored.document)).toEqual([]);
    const versions = (await owner.get(history)).json() as { revision: number; snapshots: SnapshotInfo[] };
    const previous = versions.snapshots.filter(item => item.kind === 'before-restore');
    expect(previous).toMatchObject([{ sourceRevision: 3 }]);
    expect((await owner.get(history + '/' + previous[0].id)).json().document).toEqual(current.document);
    const competing = await Promise.all([restore(4), put(edited, 4)]);
    expect(competing.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await owner.get(erd)).json().revision).toBe(5);

    await db.query("UPDATE erd_revisions SET created_at = clock_timestamp() - interval '11 minutes' WHERE erd_id = $1 AND kind = 'checkpoint'", [original.id]);
    const unchanged = (await owner.get(erd)).json().document;
    const beforeNoop = (await checkpoints()).rows;
    expect((await put(unchanged, 5)).json().revision).toBe(6);
    expect((await checkpoints()).rows).toEqual(beforeNoop);
    await db.query(`INSERT INTO erd_revisions (id, erd_id, source_revision, payload, kind, created_by, created_at)
      SELECT gen_random_uuid(), $1, 1, $2::jsonb, 'checkpoint', $3, clock_timestamp() - interval '20 minutes'
      FROM generate_series(1,55)`, [original.id, JSON.stringify(original), owner.id]);
    await db.query("INSERT INTO erd_revisions (id, erd_id, source_revision, payload, kind, created_by) VALUES (gen_random_uuid(),$1,1,$2,'before-import',$3)",
      [original.id, JSON.stringify(original), owner.id]);
    expect((await put({ ...original, name: '체크포인트 한도' }, 6)).json().revision).toBe(7);
    const retained = (await checkpoints()).rows;
    expect(retained).toHaveLength(50);
    expect(retained.at(-1)).toEqual({ source_revision: 7 });
    const permanent = (await snapshotKinds()).rows.filter(item => item.kind !== 'checkpoint');
    expect(permanent.map(item => item.kind)).toEqual(expect.arrayContaining(['manual', 'before-import', 'before-restore']));
    expect((await owner.get(history)).json()).toMatchObject({ revision: 7, hasMore: true });
    expect((await owner.get(history + '?offset=50')).json()).toMatchObject({ revision: 7, hasMore: false });
  });
}, 90_000);
