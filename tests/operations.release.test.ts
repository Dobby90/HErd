import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErdDocument } from '@erd/model';
import { expect, it } from 'vitest';
import { createDatabase } from '../apps/api/src/database.js';
import { exportDocument, exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { scaleDocument } from '../packages/test-fixtures/src/scale.js';
import { builtApi, migrateBuilt } from './support/built-api.js';
import { withPostgres } from './support/postgres.js';

const origin = 'https://herd.release.invalid';
const settings = { NODE_ENV: 'production', ERD_DEV_LOGIN: '0', OIDC_ISSUER: 'https://oidc.release.invalid',
  OIDC_CLIENT_ID: 'release-fixture', OIDC_CLIENT_SECRET: 'fixture-oidc-secret-do-not-log' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Api = Awaited<ReturnType<typeof builtApi>>;

function actor(id = randomUUID()) {
  const token = randomBytes(32).toString('base64url');
  const csrf = digest('herd:csrf:' + token);
  return { id, token, csrf, headers: { origin, cookie: '__Host-herd-session=' + token, 'x-csrf-token': csrf } };
}

function send(api: Api, headers: Record<string, string>, path: string, method = 'GET', data?: object) {
  return api.request(path, { method, headers: { ...headers, ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data && JSON.stringify(data) });
}

async function fixtureAccount(db: ReturnType<typeof createDatabase>, name: string) {
  const user = actor();
  await db.query('INSERT INTO users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$3)', [user.id, 'urn:herd:release', name]);
  await db.query("INSERT INTO sessions VALUES ($1,$2,now() + interval '30 minutes')", [digest(user.token), user.id]);
  return user;
}

async function settled(api: Api, headers: Record<string, string>, id: string, state: string) {
  let job: { state: string; output: { diagnostics: Array<{ code: string }> } } | undefined;
  await expect.poll(async () => {
    job = await send(api, headers, '/api/sql/jobs/' + id).then(response => response.json());
    return job?.state;
  }, { timeout: 11_500, interval: 25 }).toBe(state);
  return job!;
}

it('starts with separate probes, restores an actual service backup, recovers after restart and scrubs logs and expired data', async () => {
  await withPostgres(async cluster => {
    expect(cluster.query('SHOW server_version_num')).toBe('170012');
    const area = await mkdtemp(join(tmpdir(), 'herd-db-backup-'));
    const db = createDatabase(cluster.connectionString);
    db.on('error', (error: Error & { code?: string }) => {
      if (error.code !== '57P01') throw error;
    });
    let api = await builtApi(cluster.connectionString, origin, { ...settings, SQL_JOB_TTL_MS: '500' });
    try {
      expect((await api.request('/api/health')).status).toBe(200);
      expect((await api.request('/api/ready')).status).toBe(503);
      expect(migrateBuilt(cluster.connectionString)).toContain('004-sharing-history.sql');
      expect(migrateBuilt(cluster.connectionString)).toContain('up to date');
      expect((await api.request('/api/ready')).status).toBe(200);
      const checked = await db.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = '004-sharing-history.sql'");
      await db.query("UPDATE schema_migrations SET checksum = 'fixture-mismatch' WHERE name = '004-sharing-history.sql'");
      expect((await api.request('/api/ready')).status).toBe(503);
      expect((await api.request('/api/health')).status).toBe(200);
      await db.query("UPDATE schema_migrations SET checksum = $1 WHERE name = '004-sharing-history.sql'", [checked.rows[0].checksum]);

      const owner = await fixtureAccount(db, 'release owner');
      const viewer = await fixtureAccount(db, 'release viewer');
      const write = (path: string, method: string, data?: object) => send(api, owner.headers, path, method, data);
      const created = await write('/api/projects', 'POST', { name: 'fixture-project-품질' });
      expect(created.status).toBe(201);
      const project = '/api/projects/' + (await created.json()).id;
      const code = (await send(api, viewer.headers, '/api/me').then(response => response.json())).user.shareCode;
      expect((await write(project + '/members', 'POST', { shareCode: code, role: 'viewer' })).status).toBe(201);
      const original = exportDocument(randomUUID());
      original.name = 'fixture-body <em>설명</em> O\'Brien';
      original.extensions = [{ namespace: 'archive-fixture', version: 712, data: { text: '배포 🧪 \\u0000' } }];
      const erd = '/api/erds/' + original.id;
      expect((await write(project + '/erds', 'POST', { document: original })).status).toBe(201);
      const malformed = { ...original, name: 'invalid ' + String.fromCharCode(0xd800) };
      expect((await write(erd, 'PUT', { baseRevision: 1, mutationId: randomUUID(), document: malformed })).status).toBe(400);
      expect((await write(erd, 'PUT', { baseRevision: 1, mutationId: randomUUID(), document: { ...original, formatVersion: 2 } })).status).toBe(400);
      const saved = await write(erd + '/revisions', 'POST', { baseRevision: 1, description: '백업 전 저장' });
      expect(saved.status).toBe(201);
      const snapshot = erd + '/revisions/' + (await saved.json()).id;
      const changed = { ...original, name: 'fixture-edit <b>변경</b>' };
      const edit = { baseRevision: 1, mutationId: randomUUID(), document: changed };
      expect((await write(erd, 'PUT', edit)).status).toBe(200);
      expect((await write('/api/auth/development', 'POST')).status).toBe(404);
      expect((await send(api, {}, erd)).status).toBe(401);
      const stamp = 'release-sql-payload-marker';
      const job = await write(project + '/sql/jobs', 'POST', { kind: 'parse', target: exportTarget,
        mutationId: randomUUID(), defaultNamespace: 'public', sql: 'CREATE TABLE stable_job (id integer); /* ' + stamp + ' */' });
      expect(job.status).toBe(202);
      const jobId = (await job.json()).id;
      await settled(api, owner.headers, jobId, 'succeeded');
      await expect.poll(() => api.logs().includes(jobId) && api.logs().includes('durationMs')).toBe(true);
      for (const privateValue of [stamp, original.name, viewer.token, owner.token, owner.csrf, settings.OIDC_CLIENT_SECRET, 'fixture-body']) {
        expect(api.logs()).not.toContain(privateValue);
      }
      expect(api.logs()).toContain('SQL job completed');

      const archive = join(area, 'service.dump');
      execFileSync('pg_dump', ['--dbname', cluster.connectionString, '--format=custom', '--no-owner', '--no-acl', '--file', archive], { timeout: 15000 });
      cluster.query('CREATE DATABASE restored_service');
      const destination = new URL(cluster.connectionString);
      destination.pathname = 'restored_service';
      execFileSync('pg_restore', ['--dbname', destination.href, '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', archive],
        { timeout: 15000 });
      const restored = await builtApi(destination.href, origin, settings);
      try {
        expect((await restored.request('/api/ready')).status).toBe(200);
        expect(await send(restored, viewer.headers, erd).then(response => response.json())).toMatchObject({ revision: 2, document: changed });
        expect(await send(restored, viewer.headers, snapshot).then(response => response.json())).toMatchObject({ sourceRevision: 1, document: original });
        expect(await send(restored, owner.headers, project + '/members').then(response => response.json()))
          .toEqual(expect.arrayContaining([expect.objectContaining({ id: viewer.id, role: 'viewer' })]));
        expect((await send(restored, viewer.headers, erd, 'PUT', edit)).status).toBe(403);
        expect(await send(restored, owner.headers, erd, 'PUT', edit).then(response => response.json())).toMatchObject({ revision: 2 });
      } finally { await restored.close(); }
      console.log(JSON.stringify({ backupBytes: (await stat(archive)).size, restoredDatabase: 'restored_service', erdRevision: 2 }));

      cluster.stop();
      expect((await api.request('/api/health')).status).toBe(200);
      expect((await api.request('/api/ready')).status).toBe(503);
      cluster.start();
      expect((await api.request('/api/ready')).status).toBe(200);
      expect(await write(erd, 'PUT', edit).then(response => response.json())).toMatchObject({ revision: 2 });

      await db.query("UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1", [viewer.id]);
      await db.query("INSERT INTO oidc_logins VALUES ('expired-fixture','state','nonce','verifier','/',clock_timestamp() - interval '1 second')");
      await db.query("UPDATE erd_mutations SET expires_at = clock_timestamp() - interval '1 second' WHERE erd_id = $1", [original.id]);
      await db.query(`INSERT INTO sql_import_mutations (user_id, mutation_id, project_id, erd_id, request_hash, result, expires_at)
        VALUES ($1,$2,$3,$4,'fixture','{}',clock_timestamp() - interval '1 second')`,
      [owner.id, randomUUID(), project.split('/').at(-1), original.id]);
      expect((await send(api, viewer.headers, erd)).status).toBe(401);
      await expect.poll(() => cluster.query(`SELECT (SELECT count(*) FROM sessions WHERE expires_at <= now()) +
        (SELECT count(*) FROM oidc_logins) + (SELECT count(*) FROM erd_mutations WHERE erd_id = '${original.id}') +
        (SELECT count(*) FROM sql_import_mutations) + (SELECT count(*) FROM sql_jobs WHERE id = '${jobId}')`),
      { timeout: 4_000, interval: 80 }).toBe('0');

      await api.close();
      api = await builtApi(cluster.connectionString, origin, settings);
      expect((await api.request('/api/ready')).status).toBe(200);
      expect(await write(erd, 'GET').then(response => response.json())).toMatchObject({ revision: 2, document: changed });
      await db.query("UPDATE erds SET payload = jsonb_set(payload,'{formatVersion}','0') WHERE id = $1", [original.id]);
      expect(await write(erd, 'GET').then(response => response.json())).toMatchObject({ revision: 2, document: changed });
      await db.query("UPDATE erds SET payload = jsonb_set(payload,'{formatVersion}','2') WHERE id = $1", [original.id]);
      expect((await write(erd, 'GET')).status).toBe(422);
      expect((await db.query("SELECT payload->>'formatVersion' AS version FROM erds WHERE id = $1", [original.id])).rows[0].version).toBe('2');
    } finally {
      await api.close();
      await db.end();
      await rm(area, { recursive: true, force: true });
    }
  });
});

it('bounds UTF-8 SQL, JSON bytes, aggregate catalog counts and isolated workers', async () => {
  await withPostgres(async cluster => {
    migrateBuilt(cluster.connectionString);
    const db = createDatabase(cluster.connectionString);
    let api = await builtApi(cluster.connectionString, origin, { ...settings, SQL_JOB_MAX_ACTIVE: '1', SQL_JOB_WORKERS: '1' });
    const durations: Record<string, number> = {};
    async function time<T>(label: string, run: () => Promise<T>) {
      const start = performance.now();
      const result = await run();
      durations[label] = Math.round(performance.now() - start);
      return result;
    }
    try {
      const owner = await fixtureAccount(db, 'boundaries');
      const write = (path: string, method: string, data?: object) => send(api, owner.headers, path, method, data);
      expect((await api.request('/api/ready')).status).toBe(200);
      const project = '/api/projects/' + (await write('/api/projects', 'POST', { name: '문서·입력 경계' }).then(response => response.json())).id;
      const jobs = project + '/sql/jobs';
      const erds = project + '/erds';
      const parse = (sql: string) => write(jobs, 'POST', { kind: 'parse', sql, target: exportTarget, defaultNamespace: 'public', mutationId: randomUUID() });

      const sqlBytes = 5 * 1024 * 1024;
      const intro = 'CREATE TABLE boundary_check (id integer); /*한글';
      const sql = intro + 'x'.repeat(sqlBytes - Buffer.byteLength(intro) - 2) + '*/';
      expect(Buffer.byteLength(sql)).toBe(sqlBytes);
      expect((await time('sqlOversizeRejectMs', () => parse(sql + ' '))).status).toBe(413);
      const full = await time('sql5MiBMs', async () => {
        const response = await parse(sql);
        expect(response.status).toBe(202);
        return settled(api, owner.headers, (await response.json()).id, 'succeeded');
      });
      expect(full.output.diagnostics).toEqual([]);
      const doc = exportDocument(randomUUID());
      doc.extensions.push({ namespace: 'limit', version: 1, data: '' });
      const documentBytes = 20 * 1024 * 1024;
      doc.extensions[0].data = 'x'.repeat(documentBytes - Buffer.byteLength(JSON.stringify(doc)));
      expect(Buffer.byteLength(JSON.stringify(doc))).toBe(documentBytes);
      expect((await time('document20MiBMs', () => write(erds, 'POST', { document: doc }))).status).toBe(201);
      const excess = { ...doc, extensions: [{ namespace: 'limit', version: 1, data: doc.extensions[0].data + 'x' }] };
      expect((await time('documentOversizeRejectMs', () => write(erds, 'POST', { document: excess }))).status).toBe(413);

      const maximum = scaleDocument(randomUUID(), 1000, 5000);
      const catalog = maximum.catalog;
      expect(catalog.columns).toHaveLength(20000);
      expect((await time('maximumCatalogMs', () => write(erds, 'POST', { document: maximum }))).status).toBe(201);
      const over = (label: string, change: Partial<ErdDocument['catalog']>) => time(label,
        () => write(erds, 'POST', { document: { ...maximum, id: randomUUID(), catalog: { ...catalog, ...change } } }));
      expect((await over('tooManyTablesMs', { tables: [...catalog.tables, { ...catalog.tables[0], id: 'extra-table', columnIds: [] }] })).status).toBe(413);
      expect((await over('tooManyColumnsMs', { columns: [...catalog.columns, { ...catalog.columns[0], id: 'extra-column' }] })).status).toBe(413);
      expect((await over('tooManyFksMs', { constraints: [...catalog.constraints, { ...catalog.constraints.at(-1)!, id: 'extra-fk' }] })).status).toBe(413);

      const queued = await parse(sql);
      expect(queued.status).toBe(202);
      const jobId = (await queued.json()).id;
      const overflow = await parse('CREATE TABLE second_input (id integer);');
      expect(overflow.status).toBe(429);
      expect((await overflow.json()).code).toBe('SQL_QUEUE_FULL');
      const signals = await Promise.all([
        time('healthDuringWorkerMs', () => api.request('/api/health')),
        time('readDuringWorkerMs', () => write('/api/erds/' + maximum.id, 'GET')),
        time('cancelDuringWorkerMs', () => write('/api/sql/jobs/' + jobId, 'DELETE')),
      ]);
      expect(signals.every(response => response.ok)).toBe(true);
      expect(await signals[2].json()).toMatchObject({ state: 'cancelled' });
      expect((await db.query('SELECT snapshot FROM sql_jobs WHERE id = $1', [jobId])).rows[0].snapshot).toBeNull();
      for (const [options, code] of [[{ SQL_JOB_TIMEOUT_MS: '5' }, 'SQL_JOB_TIMEOUT'],
        [{ SQL_WORKER_HEAP_MB: '4' }, 'SQL_WORKER_ERROR']] as const) {
        await api.close();
        api = await builtApi(cluster.connectionString, origin, { ...settings, ...options });
        expect((await api.request('/api/ready')).status).toBe(200);
        const response = await parse(sql);
        expect(response.status).toBe(202);
        const id = (await response.json()).id;
        const failure = await time(code, () => settled(api, owner.headers, id, 'failed'));
        expect(failure.output.diagnostics[0].code).toBe(code);
        expect((await api.request('/api/health')).status).toBe(200);
      }
      console.log(JSON.stringify({ sqlBytes, documentBytes, catalog: [1000, 20000, 5000], durations }));
    } finally {
      await api.close();
      await db.end();
    }
  });
});
