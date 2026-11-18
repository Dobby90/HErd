import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ImportApplied, ParseSqlJob } from '@erd/sql-contract';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { withPostgres } from './support/postgres.js';

const origin = 'http://127.0.0.1:5173';
type Headers = { cookie: string; origin: string; 'x-csrf-token': string };
const marker = 'import_without_execution';

it('requires confirmation and current access, preserves the prior revision, and replays successful imports beyond analysis TTL', async () => {
  await withPostgres(async cluster => {
    const db = createDatabase(cluster.connectionString);
    const connect = (timeoutMs = 10_000) => createApi({
      pool: createDatabase(cluster.connectionString), auth: { origin, devLogin: false },
      jobs: { timeoutMs, ttlMs: 60_000, userLimit: 2, workers: 1, maxInputBytes: 4096 },
    }).api;
    await migrate(db);
    let api = connect();
    const session = async (subject: string) => {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      await db.query('INSERT INTO users (id, issuer, subject, display_name) VALUES ($1,$2,$3,$3)', [id, 'urn:fixture:oidc', subject]);
      await db.query("INSERT INTO sessions VALUES ($1,$2,now() + interval '1 hour')",
        [createHash('sha256').update(token).digest('hex'), id]);
      const cookie = 'herd-session=' + token;
      const me = await api.inject({ url: '/api/me', headers: { cookie } });
      return { id, headers: { cookie, origin, 'x-csrf-token': me.json().csrfToken } satisfies Headers };
    };
    const state = (id: string, headers: Headers) => api.inject({ url: '/api/sql/jobs/' + id, headers });
    const settled = async (id: string, headers: Headers) => {
      let job: ParseSqlJob | undefined;
      await expect.poll(async () => {
        job = (await state(id, headers)).json<ParseSqlJob>();
        return job.state;
      }, { timeout: 10_000, interval: 15 }).toMatch(/succeeded|failed|cancelled/);
      return job!;
    };
    try {
      api.addHook('onSend', (request, reply, _payload, done) => {
        if (request.method === 'POST' && request.headers['x-drop-import-response'] === '1' && reply.statusCode === 201) {
          reply.hijack();
          reply.raw.destroy();
        } else done();
      });
      const base = await api.listen({ host: '127.0.0.1', port: 0 });
      const owner = await session('owner');
      const editor = await session('editor');
      const viewer = await session('viewer');
      const project = (await api.inject({ method: 'POST', url: '/api/projects', headers: owner.headers, payload: { name: 'DDL Import' } })).json();
      const url = '/api/projects/' + project.id;
      await db.query("INSERT INTO project_members VALUES ($1,$2,'editor'),($1,$3,'viewer')", [project.id, editor.id, viewer.id]);
      const analyze = (sql: string, headers = editor.headers, target = exportTarget) => api.inject({
        method: 'POST', url: url + '/sql/jobs', headers,
        payload: { kind: 'parse', target, defaultNamespace: 'public', sql, mutationId: randomUUID() },
      });
      const apply = (id: string, payload: Record<string, unknown>, headers = editor.headers) => api.inject({
        method: 'POST', url: '/api/sql/jobs/' + id + '/apply', headers, payload,
      });
      expect((await api.inject('/api/sql/dialects')).json()[0].maxInputBytes).toBe(4096);
      expect((await analyze('CREATE TABLE t (id integer);', viewer.headers)).statusCode).toBe(403);
      expect((await analyze('CREATE TABLE t (id integer);', editor.headers, { ...exportTarget, engineVersion: '99' })).statusCode).toBe(422);
      expect((await analyze('a'.repeat(4097))).json()).toMatchObject({ code: 'SQL_INPUT_TOO_LARGE' });
      const userSql = `CREATE TABLE ${marker} (id integer PRIMARY KEY);
        CREATE TABLE alpha (id integer); CREATE TABLE beta (id integer); CREATE TABLE delta (id integer); CREATE TABLE epsilon (id integer);
        CREATE VIEW excluded AS SELECT * FROM ${marker};`;
      const start = await analyze(userSql);
      expect(start.statusCode, start.body).toBe(202);
      const job = await settled(start.json().id, editor.headers);
      expect(job).toMatchObject({ kind: 'parse', state: 'succeeded', output: { losses: [{ feature: 'ViewStmt' }] } });
      expect((await state(job.id, owner.headers)).statusCode).toBe(404);
      expect((await state(job.id, viewer.headers)).statusCode).toBe(404);
      expect((await api.inject({ url: url + '/erds', headers: owner.headers })).json()).toEqual([]);
      expect(cluster.query(`SELECT to_regclass('public.${marker}') IS NULL`)).toBe('t');
      expect((await db.query('SELECT snapshot IS NULL AS cleared FROM sql_jobs WHERE id = $1', [job.id])).rows[0].cleared).toBe(true);

      const create = { mode: 'create', name: '업로드 결과', mutationId: randomUUID() };
      expect((await apply(job.id, create)).json()).toMatchObject({ code: 'SQL_LOSS_CONFIRMATION_REQUIRED' });
      expect((await apply(job.id, { ...create, lossFingerprint: 'a'.repeat(64) })).statusCode).toBe(409);
      const confirmed = { ...create, lossFingerprint: job.output?.lossFingerprint };
      await expect(fetch(base + '/api/sql/jobs/' + job.id + '/apply', {
        method: 'POST', headers: { ...editor.headers, 'content-type': 'application/json', 'x-drop-import-response': '1' },
        body: JSON.stringify(confirmed),
      })).rejects.toThrow();
      await db.query("UPDATE sql_jobs SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE id = $1", [job.id]);
      expect((await state(job.id, editor.headers)).statusCode).toBe(404);
      const recovered = await apply(job.id, confirmed);
      expect(recovered.statusCode, recovered.body).toBe(200);
      const saved = recovered.json<ImportApplied>();
      expect(saved.revision).toBe(1);
      expect((await apply(job.id, { ...confirmed, mutationId: randomUUID() })).statusCode).toBe(404);
      expect((await api.inject({ url: url + '/erds', headers: owner.headers })).json()).toHaveLength(1);
      const erd = '/api/erds/' + saved.erdId;
      const previous = (await api.inject({ url: erd, headers: owner.headers })).json().document;
      expect(previous.catalog.tables).toHaveLength(5);
      expect(previous.views[0].instances).toMatchObject([{ x: 0, y: 0 }, { x: 360, y: 0 }, { x: 720, y: 0 }, { x: 1080, y: 0 }, { x: 0 }]);
      expect(previous.views[0].instances[4].y).toBeGreaterThan(0);
      expect(cluster.query(`SELECT to_regclass('public.${marker}') IS NULL`)).toBe('t');

      const unresolved = await settled((await analyze('CREATE TABLE impossible (val hstore); CREATE EXTENSION hstore;')).json().id, editor.headers);
      expect(unresolved.state).toBe('failed');
      expect(unresolved.output).not.toHaveProperty('catalog');
      expect((await apply(unresolved.id, { ...create, mutationId: randomUUID() })).statusCode).toBe(409);
      const replacement = await settled((await analyze('CREATE TABLE replacement (val integer CHECK (val >= 0));')).json().id, editor.headers);
      expect(replacement.state).toBe('succeeded');
      const changed = { ...previous, name: '업데이트한 이름', views: [{ ...previous.views[0], name: '이전 뷰' }] };
      expect((await api.inject({ method: 'PUT', url: erd, headers: owner.headers, payload: {
        baseRevision: 1, mutationId: randomUUID(), document: changed,
      } })).statusCode).toBe(200);
      const replace = { mode: 'replace', erdId: saved.erdId, baseRevision: 1, mutationId: randomUUID() };
      expect((await apply(replacement.id, replace)).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
      expect((await db.query('SELECT id FROM erd_revisions WHERE erd_id = $1', [saved.erdId])).rowCount).toBe(0);
      await db.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [project.id, editor.id]);
      expect((await state(replacement.id, editor.headers)).statusCode).toBe(404);
      expect((await apply(replacement.id, { ...replace, baseRevision: 2 })).statusCode).toBe(403);
      expect((await apply(job.id, confirmed)).statusCode).toBe(403);
      await db.query("UPDATE project_members SET role = 'editor' WHERE project_id = $1 AND user_id = $2", [project.id, editor.id]);

      const opts = { ...replace, baseRevision: 2 };
      const requests = [opts, { ...opts, mutationId: randomUUID() }];
      const competed = await Promise.all(requests.map(input => apply(replacement.id, input)));
      expect(competed.map(response => response.statusCode).sort()).toEqual([200, 409]);
      const succeeded = competed.findIndex(response => response.statusCode === 200);
      expect((await apply(replacement.id, requests[succeeded])).json()).toEqual(competed[succeeded].json());
      const snapshots = (await db.query('SELECT source_revision, kind, payload FROM erd_revisions WHERE erd_id = $1', [saved.erdId])).rows;
      expect(snapshots).toEqual([{ source_revision: 2, kind: 'before-import', payload: changed }]);
      const current = (await api.inject({ url: erd, headers: owner.headers })).json();
      expect(current).toMatchObject({ revision: 3, document: { id: saved.erdId, name: '업데이트한 이름',
        catalog: { tables: [{ physicalName: 'replacement' }] }, views: [{ name: '기본 뷰', instances: [{ x: 0, y: 0 }] }] } });
      expect(current.document.views[0].id).not.toBe(previous.views[0].id);

      const active = (await analyze('CREATE TABLE cancelled (id integer);')).json<ParseSqlJob>();
      const cancelled = await api.inject({ method: 'DELETE', url: '/api/sql/jobs/' + active.id, headers: editor.headers });
      expect(cancelled.json().state).toBe('cancelled');
      expect((await apply(active.id, { ...create, mutationId: randomUUID() })).statusCode).toBe(409);
      await api.close();
      api = connect(1);
      const timed = (await analyze('CREATE TABLE timeout_test (id integer);')).json<ParseSqlJob>();
      const timeout = await settled(timed.id, editor.headers);
      expect(timeout).toMatchObject({ state: 'failed', output: { diagnostics: [{ code: 'SQL_JOB_TIMEOUT' }] } });
      expect((await apply(timed.id, { ...create, mutationId: randomUUID() })).statusCode).toBe(409);
      expect((await api.inject({ url: erd, headers: owner.headers })).json()).toEqual(current);
    } finally {
      await api.close();
      await db.end();
    }
  });
}, 90_000);
