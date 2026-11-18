import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const base = process.argv[2];
const origin = process.env.APP_ORIGIN;
let cookie;
let csrf;
const response = (path, method = 'GET', body) => fetch(base + path, {
  method, signal: AbortSignal.timeout(5_000),
  headers: {
    ...(cookie && { Cookie: cookie }),
    ...(csrf && { 'X-CSRF-Token': csrf }),
    ...(method !== 'GET' && { Origin: origin }),
    ...(body && { 'Content-Type': 'application/json' }),
  },
  body: body && JSON.stringify(body),
});
async function json(path, method, body, status = 200) {
  const result = await response(path, method, body);
  assert.equal(result.status, status, path);
  return result.json();
}
async function waitForJob(id) {
  for (let i = 0; i < 100; ++i) {
    const current = await json('/api/sql/jobs/' + id);
    if (current.state === 'succeeded') return current;
    assert.ok(['queued', 'running'].includes(current.state), 'SQL worker failed');
    await setTimeout(120);
  }
  throw new Error('SQL job did not settle');
}

assert.deepEqual(await json('/api/health'), { status: 'ok' });
assert.deepEqual(await json('/api/ready'), { status: 'ready' });
const html = await (await response('/?workspace=1')).text();
const entry = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
assert.ok(entry, 'Built web entry was not served');
assert.equal((await response(entry)).status, 200);
assert.equal((await response('/assets/missing.js')).status, 404);
const login = await response('/api/auth/development', 'POST');
assert.equal(login.status, 204);
cookie = login.headers.get('set-cookie').split(';')[0];
csrf = (await json('/api/me')).csrfToken;
const project = await json('/api/projects', 'POST', { name: 'Compose release smoke' }, 201);
const jobs = '/api/projects/' + project.id + '/sql/jobs';
const parse = await json(jobs, 'POST', {
  kind: 'parse', mutationId: randomUUID(), target: { dialectId: 'postgresql', engineVersion: '17' },
  defaultNamespace: 'public', sql: 'CREATE TABLE package_check (id serial PRIMARY KEY);',
}, 202);
const parsed = await waitForJob(parse.id);
assert.equal(parsed.output.catalog.tables[0].physicalName, 'package_check');
const applied = await json('/api/sql/jobs/' + parse.id + '/apply', 'POST', {
  mode: 'create', name: 'Packaged ERD', mutationId: randomUUID(),
}, 201);
const snapshot = await json('/api/erds/' + applied.erdId + '/revisions', 'POST', {
  baseRevision: applied.revision, description: 'Release checkpoint',
}, 201);
assert.equal(snapshot.sourceRevision, 1);
const generate = await json(jobs, 'POST', {
  kind: 'generate', erdId: applied.erdId, revision: 1, mutationId: randomUUID(),
}, 202);
assert.match((await waitForJob(generate.id)).output.sql, /CREATE TABLE "public"\."package_check"/);
console.log('Compose verified built web assets, DB readiness, authentication, SQL workers, and snapshot storage.');
