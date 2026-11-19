import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validateDocumentStructure } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { readConfig } from '../apps/api/src/config.js';
import { createDatabase, migrate } from '../apps/api/src/database.js';
import { mockIdentityProvider } from './support/oidc.js';
import { withPostgres } from './support/postgres.js';

function cookies(value: number | string | string[] | undefined, name: string) {
  const set = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const entry = set.find(cookie => cookie.startsWith(name + '='));
  if (!entry) throw new Error('Missing cookie ' + name);
  expect(entry).toContain('HttpOnly');
  expect(entry).toContain('SameSite=Lax');
  return entry.split(';', 1)[0];
}

async function callback(api: FastifyInstance, subject: string, options: { badState?: boolean; badNonce?: boolean } = {}) {
  const start = await api.inject({ url: '/api/auth/login?returnTo=%2F%3Fworkspace%3D1%26mode%3Dtest' });
  expect(start.statusCode, start.body).toBe(302);
  const pending = cookies(start.headers['set-cookie'], 'herd-login');
  const authorization = new URL(String(start.headers.location));
  authorization.searchParams.set('test_subject', subject);
  if (options.badNonce) authorization.searchParams.set('bad_nonce', '1');
  const authorized = await fetch(authorization, { redirect: 'manual' });
  expect(authorized.status).toBe(302);
  const redirect = new URL(authorized.headers.get('location')!);
  if (options.badState) redirect.searchParams.set('state', 'wrong');
  const path = redirect.pathname + redirect.search;
  return { response: await api.inject({ url: path, headers: { cookie: pending } }), pending, path };
}

async function login(api: FastifyInstance, subject: string, origin: string) {
  const signOn = await callback(api, subject);
  expect(signOn.response.statusCode, signOn.response.body).toBe(302);
  expect(signOn.response.headers.location).toBe('/?workspace=1&mode=test');
  expect((await api.inject({ url: signOn.path, headers: { cookie: signOn.pending } })).statusCode).toBe(401);
  const session = cookies(signOn.response.headers['set-cookie'], 'herd-session');
  const me = await api.inject({ url: '/api/me', headers: { cookie: session } });
  expect(me.headers['cache-control']).toBe('no-store');
  const identity = me.json<{ user: { id: string; displayName: string }; csrfToken: string }>();
  expect(identity.user.displayName).toBe(subject);
  return { id: identity.user.id, headers: { cookie: session, origin, 'x-csrf-token': identity.csrfToken } };
}

function template(): ErdDocument {
  const document = structuredClone(sampleDocument);
  document.id = randomUUID();
  document.catalog.enums.push({ id: 'states', namespaceId: 'public-schema', physicalName: 'states', values: ['enabled'] });
  document.catalog.sequences.push({ id: 'order_seq', namespaceId: 'public-schema', physicalName: 'order_seq', ownedByColumnId: 'order-number' });
  document.catalog.columns.find(column => column.id === 'product-name')!.type.reference = { kind: 'enum', enumId: 'states' };
  document.catalog.indexes[0].predicate = { ...document.target, sql: 'name IS NOT NULL', references: ['product-name'] };
  return document;
}

it('validates OIDC and protects project routes, concurrent saves, mutations, and durable PostgreSQL data', async () => {
  expect(() => readConfig({ NODE_ENV: 'production', ERD_DEV_LOGIN: '1' })).toThrow(/ERD_DEV_LOGIN/);
  await withPostgres(async cluster => {
    const provider = await mockIdentityProvider();
    let db = createDatabase(cluster.connectionString);
    const origin = 'http://127.0.0.1:5173';
    const auth = { origin, devLogin: false, oidc: provider.settings };
    let api = createApi({ pool: createDatabase(cluster.connectionString), auth }).api;
    try {
      const applied = execFileSync(process.execPath, ['scripts/migrate.mjs'],
        { env: { ...process.env, DATABASE_URL: cluster.connectionString }, encoding: 'utf8' });
      expect(applied.trim().split('\n')).toEqual([
        '001-projects.sql', '002-sql-jobs.sql', '003-sql-import.sql', '004-sharing-history.sql', '005-local-accounts.sql',
        '006-user-directory.sql', '007-service-administration.sql',
      ]);
      expect(await migrate(db)).toEqual([]);
      api.addHook('onSend', (request, reply, _payload, done) => {
        if (request.headers['x-drop-test-response'] === '1' && request.method === 'PUT' && reply.statusCode === 200) {
          reply.hijack();
          reply.raw.destroy();
        } else {
          done();
        }
      });
      const base = await api.listen({ host: '127.0.0.1', port: 0 });
      expect((await api.inject('/api/ready')).json()).toEqual({ status: 'ready' });
      expect((await api.inject('/api/projects')).json()).toMatchObject({ code: 'LOGIN_REQUIRED', requestId: expect.any(String) });
      expect((await api.inject({ method: 'POST', url: '/api/auth/development' })).statusCode).toBe(404);
      expect((await callback(api, 'never', { badState: true })).response.statusCode).toBe(401);
      expect(provider.exchanges).toBe(0);
      expect((await callback(api, 'never', { badNonce: true })).response.statusCode).toBe(401);
      const alice = await login(api, 'alice', origin);
      const bob = await login(api, 'bob', origin);
      const viewer = await login(api, 'viewer', origin);
      expect((await login(api, 'alice', origin)).id).toBe(alice.id);
      const tokens = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [alice.id]);
      expect(tokens.rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash) && !alice.headers.cookie.includes(row.token_hash))).toBe(true);

      const projects = '/api/projects';
      const csrf = await api.inject({ method: 'POST', url: projects, headers: { ...alice.headers, origin: 'https://another.test' }, payload: { name: 'Denied' } });
      expect(csrf.json()).toMatchObject({ code: 'CSRF_REJECTED' });
      const noToken = await api.inject({ method: 'POST', url: projects, headers: { origin, cookie: alice.headers.cookie }, payload: { name: 'Denied' } });
      expect(noToken.statusCode).toBe(403);
      const created = await api.inject({ method: 'POST', url: projects, headers: alice.headers, payload: { name: 'Commerce' } });
      expect(created.statusCode, created.body).toBe(201);
      const project = created.json<{ id: string; role: string }>();
      expect(project.role).toBe('owner');
      const pid = projects + '/' + project.id;
      const renamed = await api.inject({ method: 'PATCH', url: pid, headers: alice.headers, payload: { name: 'Shop' } });
      expect(renamed.json()).toMatchObject({ name: 'Shop', documentCount: 0, role: 'owner' });
      const initial = template();
      const createErd = await api.inject({ method: 'POST', url: pid + '/erds', headers: alice.headers, payload: { document: initial } });
      expect(createErd.statusCode, createErd.body).toBe(201);
      expect(createErd.json()).toMatchObject({ revision: 1, document: { id: initial.id } });
      const path = '/api/erds/' + initial.id;

      const save = (document: ErdDocument, baseRevision: number) => ({ baseRevision, mutationId: randomUUID(), document });
      const send = (payload: ReturnType<typeof save>, headers = alice.headers) => api.inject({ method: 'PUT', url: path, headers, payload });
      const one = save({ ...initial, name: 'Concurrent A' }, 1);
      const two = save({ ...initial, name: 'Concurrent B' }, 1);
      const results = await Promise.all([send(one), send(two)]);
      expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
      const winner = results[0].statusCode === 200 ? one : two;
      const conflict = results.find(result => result.statusCode === 409)!;
      expect(conflict.json()).toMatchObject({ code: 'REVISION_CONFLICT', details: { revision: 2 } });
      expect((await api.inject({ url: projects, headers: bob.headers })).json()).toEqual([]);
      for (const url of [pid, pid + '/erds', path]) {
        expect((await api.inject({ url, headers: bob.headers })).statusCode).toBe(404);
      }
      expect((await send(winner, bob.headers)).statusCode).toBe(404);

      const dropped = save({ ...initial, name: 'Committed before disconnect' }, 2);
      await expect(fetch(base + path, { method: 'PUT', headers: { ...alice.headers, 'content-type': 'application/json',
        'x-drop-test-response': '1' }, body: JSON.stringify(dropped) })).rejects.toThrow();
      const retry = await send(dropped);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ revision: 3 });
      const after = (await api.inject({ url: path, headers: alice.headers })).json();
      expect(after).toMatchObject({ revision: 3, updatedAt: retry.json().updatedAt, document: { name: 'Committed before disconnect' } });
      expect((await send({ ...dropped, document: { ...initial, name: 'Different request' } })).json()).toMatchObject({ code: 'MUTATION_MISMATCH' });
      const differentPayload = { ...dropped.document, revision: 99 };
      expect((await send({ ...dropped, document: differentPayload })).json()).toMatchObject({ code: 'MUTATION_MISMATCH' });
      await db.query("UPDATE erd_mutations SET expires_at = now() - interval '1 second' WHERE mutation_id = $1", [dropped.mutationId]);
      expect((await send(dropped)).json()).toMatchObject({ code: 'REVISION_CONFLICT' });

      await db.query("INSERT INTO project_members VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')", [project.id, bob.id, viewer.id]);
      expect((await send(winner, bob.headers)).json()).toMatchObject({ code: 'REVISION_CONFLICT' });
      expect((await send(dropped, viewer.headers)).statusCode).toBe(403);
      expect((await api.inject({ url: path, headers: viewer.headers })).statusCode).toBe(200);
      expect((await api.inject({ method: 'DELETE', url: path, headers: bob.headers })).statusCode).toBe(403);
      expect((await api.inject({ method: 'DELETE', url: pid, headers: bob.headers })).statusCode).toBe(403);
      expect((await api.inject({ method: 'POST', url: path + '/duplicate', headers: viewer.headers })).statusCode).toBe(403);
      expect((await send(save({ ...initial, id: randomUUID() }, 3))).json()).toMatchObject({ code: 'DOCUMENT_ID_MISMATCH' });
      expect((await send(save({ ...initial, target: { ...initial.target, engineVersion: '18' } }, 3))).json()).toMatchObject({ code: 'DOCUMENT_TARGET_MISMATCH' });
      const broken = structuredClone(initial);
      broken.catalog.tables[0].columnIds.push('missing');
      expect((await send(save(broken, 3))).json()).toMatchObject({ code: 'INVALID_DOCUMENT' });
      const huge = structuredClone(initial);
      huge.catalog.tables = Array.from({ length: 1001 }, (_, index) => ({
        id: 'table-' + index, namespaceId: 'public-schema', physicalName: 'test', columnIds: [],
      }));
      expect((await send(save(huge, 3))).statusCode).toBe(413);
      const meaningError = structuredClone(initial);
      meaningError.catalog.tables[0].physicalName = '';
      const final = await send(save(meaningError, 3), bob.headers);
      expect(final.json()).toMatchObject({ revision: 4 });

      const duplicate = await api.inject({ method: 'POST', url: path + '/duplicate', headers: bob.headers, payload: { name: 'Copy' } });
      expect(duplicate.statusCode, duplicate.body).toBe(201);
      const copy = duplicate.json<{ document: ErdDocument; revision: number }>();
      expect(copy.revision).toBe(1);
      expect(copy.document.id).not.toBe(initial.id);
      expect(validateDocumentStructure(copy.document)).toEqual([]);
      const allIds = (document: ErdDocument) => [
        document, ...Object.values(document.catalog).flat(), ...document.relationships, ...document.views,
        ...document.views.flatMap(view => [...view.instances, ...view.groups, ...view.notes]),
      ].map(object => object.id);
      const priorIds = allIds(initial);
      expect(allIds(copy.document).every(id => !priorIds.includes(id))).toBe(true);
      const { catalog, views } = copy.document;
      const orders = catalog.tables.find(table => table.physicalName === 'orders')!;
      const items = catalog.tables.find(table => table.physicalName === 'order_items')!;
      const key = catalog.constraints.find(constraint => constraint.physicalName === 'orders_pkey')!;
      const column = catalog.columns.find(column => column.physicalName === 'name')!;
      expect(catalog.constraints.find(constraint => constraint.physicalName === 'order_items_order_fk')).toMatchObject({
        tableId: items.id, targetTableId: orders.id, targetKey: { id: key.id },
        pairs: [
          { sourceColumnId: items.columnIds[0], targetColumnId: orders.columnIds[0] },
          { sourceColumnId: items.columnIds[1], targetColumnId: orders.columnIds[1] },
        ],
      });
      expect(catalog.indexes[0]).toMatchObject({ keys: [{ expression: { references: [column.id], sql: 'lower(name)' } }],
        predicate: { references: [column.id] } });
      expect(catalog.sequences[0].ownedByColumnId).toBe(orders.columnIds[1]);
      expect(column.type.reference).toEqual({ kind: 'enum', enumId: catalog.enums[0].id });
      expect(views[0].instances.find(item => item.tableId === orders.id)?.groupId).toBe(views[0].groups[0].id);
      expect(views[1].instances.find(item => item.tableId === orders.id)?.visibleColumnIds).toEqual([orders.columnIds[1]]);
      expect((await api.inject({ url: pid + '/erds', headers: viewer.headers })).json()).toHaveLength(2);
      expect((await api.inject({ url: pid, headers: alice.headers })).json()).toMatchObject({ documentCount: 2 });
      expect((await api.inject({ method: 'DELETE', url: pid, headers: alice.headers, payload: { documentCount: 1 } })).statusCode).toBe(409);

      await api.close();
      await db.end();
      cluster.restart();
      db = createDatabase(cluster.connectionString);
      expect(await migrate(db)).toEqual([]);
      api = createApi({ pool: createDatabase(cluster.connectionString), auth }).api;
      expect((await api.inject({ url: pid, headers: alice.headers })).json()).toMatchObject({ name: 'Shop', documentCount: 2 });
      expect((await api.inject({ url: path, headers: alice.headers })).json()).toMatchObject({ revision: 4,
        document: { catalog: { tables: expect.arrayContaining([expect.objectContaining({ physicalName: '' })]) } } });
      expect((await api.inject({ method: 'DELETE', url: '/api/erds/' + copy.document.id, headers: alice.headers })).statusCode).toBe(204);
      expect((await api.inject({ method: 'DELETE', url: pid, headers: alice.headers, payload: { documentCount: 1 } })).statusCode).toBe(204);
      expect((await api.inject({ url: path, headers: alice.headers })).statusCode).toBe(404);
      expect((await api.inject({ method: 'POST', url: '/api/auth/logout', headers: bob.headers })).statusCode).toBe(204);
      expect((await api.inject({ url: projects, headers: bob.headers })).statusCode).toBe(401);
    } finally {
      await api.close();
      await db.end();
      await provider.close();
    }
  });
}, 90_000);
