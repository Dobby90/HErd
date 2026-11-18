import { parentPort, workerData } from 'node:worker_threads';
import { SqlService } from '@erd/sql-service';
import type { GenerateRequest, SqlJobOutput } from '@erd/sql-contract';
import { createSqlRegistry } from './sql-registry.js';

const port = parentPort;
if (!port) throw new Error('SQL worker requires a parent port.');
const { request, previewOnly } = workerData as { request: GenerateRequest; previewOnly: boolean };
try {
  const result = await new SqlService(createSqlRegistry()).generate(request);
  const catalog = request.document.catalog;
  const namespaces = new Map(catalog.namespaces.map(item => [item.id, item.physicalName]));
  const dependencies = result.dependencies.map(dependency => {
    const item = catalog[dependency.kind].find(item => item.id === dependency.objectId);
    return { ...dependency, name: item?.physicalName ?? dependency.objectId,
      namespace: item && 'namespaceId' in item && typeof item.namespaceId === 'string' ? namespaces.get(item.namespaceId) : undefined };
  });
  const output: SqlJobOutput = { diagnostics: result.diagnostics, dependencies };
  if (result.status === 'generated' && !previewOnly) output.sql = result.sql;
  port.postMessage({ state: result.status === 'generated' ? 'succeeded' : 'failed', output });
} catch {
  port.postMessage({ state: 'failed', output: {
    diagnostics: [{ code: 'SQL_WORKER_ERROR', severity: 'error', message: 'SQL 생성 중 오류가 발생했습니다.' }], dependencies: [],
  } });
}
