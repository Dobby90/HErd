import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { postgresqlMetadata } from '@erd/dialect-postgresql/ui';
import type { GenerateSqlJob as SqlJob } from '@erd/sql-contract';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { exportDocument, exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { withPostgres } from './support/postgres.js';

const origin = 'http://127.0.0.1:5173';
type Headers = { cookie: string; origin: string; 'x-csrf-token': string };

it('pins snapshots and enforces job ownership, cancellation, timed termination, restart recovery, and TTL', async () => {
  await withPostgres(async cluster => {
    const db = createDatabase(cluster.connectionString);
    const connect = (timeoutMs = 10_000, ttlMs = 60_000) => createApi({
      pool: createDatabase(cluster.connectionString), auth: { origin, devLogin: true },
      jobs: { timeoutMs, ttlMs, userLimit: 1, workers: 1 },
    }).api;
    await migrate(db);
    let api = connect();
    const credentials = async (subject: string) => {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      await db.query('INSERT INTO users (id, issuer, subject, display_name) VALUES ($1,$2,$3,$3)', [id, 'urn:fixture:oidc', subject]);
      await db.query("INSERT INTO sessions VALUES ($1,$2,now() + interval '1 hour')",
        [createHash('sha256').update(token).digest('hex'), id]);
      const cookie = 'herd-session=' + token;
      const response = await api.inject({ url: '/api/me', headers: { cookie } });
      expect(response.json().user.id).toBe(id);
      return { id, headers: { cookie, origin, 'x-csrf-token': response.json().csrfToken } satisfies Headers };
    };
    const getJob = async (id: string, headers: Headers) => (await api.inject({ url: '/api/sql/jobs/' + id, headers })).json<SqlJob>();
    const waitFor = async (id: string, headers: Headers, state: SqlJob['state']) => {
      let observed: SqlJob | undefined;
      await expect.poll(async () => {
        observed = await getJob(id, headers);
        return observed.state;
      }, { timeout: 10_000, interval: 15 }).toBe(state);
      return observed!;
    };

    try {
      const { adapterVersion } = postgresqlMetadata;
      const profiles = (await api.inject('/api/sql/dialects')).json();
      expect(profiles).toMatchObject([{ metadata: { id: 'postgresql', adapterVersion, profiles: [{ version: '17', status: 'certified' }] },
        versions: [{ version: '17', capabilities: { table: { export: 'supported' }, expressionIndex: { export: 'unsupported' } } }] }]);
      const owner = await credentials('owner');
      const viewer = await credentials('viewer');
      const outsider = await credentials('outsider');
      const project = (await api.inject({ method: 'POST', url: '/api/projects', headers: owner.headers, payload: { name: 'DDL project' } })).json();
      const path = '/api/projects/' + project.id;
      const jobs = path + '/sql/jobs';
      const document = exportDocument(randomUUID());
      const created = await api.inject({ method: 'POST', url: path + '/erds', headers: owner.headers, payload: { document } });
      expect(created.statusCode, created.body).toBe(201);
      await db.query("INSERT INTO project_members VALUES ($1,$2,'viewer')", [project.id, viewer.id]);

      const request = { kind: 'generate', erdId: document.id, revision: 1, mutationId: randomUUID(), options: { tableIds: ['a'] } };
      const submit = (payload = request, headers = viewer.headers) => api.inject({ method: 'POST', url: jobs, headers, payload });
      expect((await api.inject({ method: 'POST', url: jobs, payload: request })).statusCode).toBe(401);
      expect((await submit(request, outsider.headers)).statusCode).toBe(404);
      const mismatched = await api.inject({ method: 'POST', url: '/api/projects/' + randomUUID() + '/sql/jobs', headers: owner.headers, payload: request });
      expect(mismatched.statusCode).toBe(404);
      const response = await submit();
      expect(response.statusCode, response.body).toBe(202);
      const job = response.json<SqlJob>();
      expect(job).toMatchObject({ revision: 1, state: 'queued', target: exportTarget, adapterVersion });
      expect((await api.inject({ url: '/api/sql/jobs/' + job.id, headers: owner.headers })).statusCode).toBe(404);
      expect((await api.inject({ method: 'DELETE', url: '/api/sql/jobs/' + job.id, headers: owner.headers })).statusCode).toBe(404);
      const changed = structuredClone(document);
      changed.catalog.tables[0].description = 'SECOND REVISION';
      const written = await api.inject({ method: 'PUT', url: '/api/erds/' + document.id, headers: owner.headers,
        payload: { baseRevision: 1, mutationId: randomUUID(), document: changed } });
      expect(written.statusCode, written.body).toBe(200);
      expect((await submit()).json()).toMatchObject({ id: job.id, revision: 1 });
      expect((await submit({ ...request, options: { tableIds: ['b'] } })).json()).toMatchObject({ code: 'MUTATION_MISMATCH' });
      expect((await submit({ ...request, mutationId: randomUUID() })).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
      const complete = await waitFor(job.id, viewer.headers, 'succeeded');
      expect(complete.output?.sql).toContain('CREATE TABLE "업무""영역"."select"');
      expect(complete.output?.sql).not.toContain('SECOND REVISION');
      expect(complete.output?.dependencies).toEqual(expect.arrayContaining([
        { kind: 'tables', name: 'select', namespace: '세일즈', objectId: 'b' },
        { kind: 'sequences', name: 'global_id', namespace: '타입', objectId: 'global' },
      ]));

      const next = { ...request, revision: 2, mutationId: randomUUID() };
      const active = (await submit(next)).json<SqlJob>();
      expect(active.state).toBe('queued');
      await waitFor(active.id, viewer.headers, 'running');
      expect((await submit({ ...next, mutationId: randomUUID() })).json()).toMatchObject({ code: 'SQL_JOB_LIMIT' });
      const cancelled = (await api.inject({ method: 'DELETE', url: '/api/sql/jobs/' + active.id, headers: viewer.headers })).json<SqlJob>();
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.output).toBeNull();
      const badSelection = (await submit({ ...next, mutationId: randomUUID(), options: { tableIds: ['missing'] } })).json<SqlJob>();
      expect((await waitFor(badSelection.id, viewer.headers, 'failed')).output).toMatchObject({
        diagnostics: [{ code: 'unknown-generation-table' }],
      });
      await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [project.id, viewer.id]);
      expect((await api.inject({ url: '/api/sql/jobs/' + job.id, headers: viewer.headers })).statusCode).toBe(404);
      expect((await api.inject({ method: 'DELETE', url: '/api/sql/jobs/' + job.id, headers: viewer.headers })).statusCode).toBe(404);

      // Orphans model a process exit after persisting either active state.
      const orphans = [randomUUID(), randomUUID()];
      for (const [index, state] of ['queued', 'running'].entries()) {
        await db.query(`INSERT INTO sql_jobs (id, project_id, erd_id, user_id, mutation_id, request_hash, revision,
          target, adapter_version, options, snapshot, state) VALUES ($1,$2,$3,$4,$5,'fixture',2,$6,$7,'{}',$8,$9)`,
        [orphans[index], project.id, document.id, owner.id, randomUUID(), JSON.stringify(exportTarget), adapterVersion,
          JSON.stringify(changed), state]);
      }
      await api.close();
      api = connect(1, 200);
      await api.ready();
      for (const orphan of orphans) {
        expect(await getJob(orphan, owner.headers)).toMatchObject({ state: 'failed', output: { diagnostics: [{ code: 'SQL_JOB_RESTARTED' }] } });
      }
      const timed = (await submit({ ...next, mutationId: randomUUID() }, owner.headers)).json<SqlJob>();
      const timeout = await waitFor(timed.id, owner.headers, 'failed');
      expect(timeout.output).toEqual({ diagnostics: [{ code: 'SQL_JOB_TIMEOUT', severity: 'error',
        message: 'SQL 작업의 실행 제한 시간을 초과했습니다.' }], dependencies: [] });
      const poll = () => api.inject({ url: '/api/sql/jobs/' + timed.id, headers: owner.headers });
      await expect.poll(async () => (await poll()).statusCode, { timeout: 2_000, interval: 20 }).toBe(404);
      await expect.poll(async () => (await db.query('SELECT id FROM sql_jobs WHERE id = $1', [timed.id])).rowCount,
        { timeout: 2_000, interval: 20 }).toBe(0);
      expect(await getJob(job.id, viewer.headers)).toMatchObject({ code: 'SQL_JOB_NOT_FOUND' });
    } finally {
      await api.close();
      await db.end();
    }
  });
}, 90_000);
