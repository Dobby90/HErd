import { createHash } from 'node:crypto';
import { SqlService } from '@erd/sql-service';
import type { GenerateRequest, ParseJobOutput, ParseRequest, SqlJobOutput } from '@erd/sql-contract';
import { createSqlRegistry } from './sql-registry.js';

type Task =
  | { kind: 'parse'; jobId: string; request: ParseRequest }
  | { kind?: 'generate'; request: GenerateRequest; previewOnly: boolean };

async function parseJob(service: SqlService, task: Extract<Task, { kind: 'parse' }>) {
  const result = await service.parse(task.request);
  const output: ParseJobOutput = { diagnostics: result.diagnostics, statements: result.statements, losses: result.losses };
  if (result.status === 'parsed') {
    output.catalog = result.catalog;
    output.lossFingerprint = createHash('sha256').update(JSON.stringify([task.jobId, result.losses])).digest('hex');
  }
  return { state: result.status === 'parsed' ? 'succeeded' : 'failed', output };
}

async function generateJob(service: SqlService, task: Exclude<Task, { kind: 'parse' }>) {
  const result = await service.generate(task.request);
  const catalog = task.request.document.catalog;
  const namespaces = new Map(catalog.namespaces.map(item => [item.id, item.physicalName]));
  const dependencies = result.dependencies.map(dependency => {
    const item = catalog[dependency.kind].find(item => item.id === dependency.objectId);
    return { ...dependency, name: item?.physicalName ?? dependency.objectId,
      namespace: item && 'namespaceId' in item && typeof item.namespaceId === 'string' ? namespaces.get(item.namespaceId) : undefined };
  });
  const output: SqlJobOutput = { diagnostics: result.diagnostics, dependencies };
  if (result.status === 'generated' && !task.previewOnly) output.sql = result.sql;
  return { state: result.status === 'generated' ? 'succeeded' : 'failed', output };
}

if (!process.send) throw new Error('SQL worker requires an IPC channel.');
const send = process.send.bind(process);
process.once('disconnect', () => process.exit(1));
const task = await new Promise<Task>(resolve => {
  process.once('message', message => resolve(message as Task));
  send({ ready: true });
});
try {
  const service = new SqlService(createSqlRegistry());
  send(await (task.kind === 'parse' ? parseJob(service, task) : generateJob(service, task)));
} catch {
  send({ state: 'failed', output: {
    diagnostics: [{ code: 'SQL_WORKER_ERROR', severity: 'error', message: 'SQL 작업 중 오류가 발생했습니다.' }], dependencies: [],
  } });
}
