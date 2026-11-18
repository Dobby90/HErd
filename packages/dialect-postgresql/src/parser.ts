import { Worker } from 'node:worker_threads';
import type { ParseLimits } from '@erd/sql-contract';

type ExpressionSummary =
  | { kind: 'function'; name: string[]; arguments: ExpressionSummary[] }
  | { kind: 'cast'; type: string[]; arrayDimensions: number; operand: ExpressionSummary }
  | { kind: 'array'; elements: ExpressionSummary[] }
  | { kind: 'operator'; name: string[]; left: ExpressionSummary; right: ExpressionSummary }
  | { kind: 'column'; name: string[] }
  | { kind: 'literal'; value: string | number }
  | { kind: 'other' };

export interface PostgresqlInspection {
  version: number;
  statementKinds: string[];
  tables: string[];
  typeNames: string[];
  columns: { name: string; array: boolean }[];
  constraintKinds: string[];
  constraintExpressions: { kind: 'default' | 'check'; expression: ExpressionSummary }[];
  compositeKeys: { columns: string[]; referencedColumns: string[] }[];
  workerExitCode: number;
}
type Summary = Omit<PostgresqlInspection, 'workerExitCode'>;
type WorkerResponse = { summary: Summary } | { error: string };

export async function inspectPostgresql(
  sql: string,
  limits: ParseLimits & { signal?: AbortSignal } = {},
): Promise<PostgresqlInspection> {
  const { maxBytes = 5 * 1024 * 1024, maxStatements = 10_000, timeoutMs = 10_000, signal } = limits;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxStatements) || maxStatements < 0) {
    throw new Error('SQL parser byte and statement limits must be nonnegative integers.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error('SQL parser deadline must fit the Node timer range.');
  }
  if (Buffer.byteLength(sql, 'utf8') > maxBytes) throw new Error('SQL byte limit exceeded.');
  if (timeoutMs <= 0) throw new Error('SQL parser deadline exceeded.');

  const worker = new Worker(new URL('./parser-worker.mjs', import.meta.url), { workerData: { sql, maxStatements } });
  const exited = new Promise<number>(resolve => worker.once('exit', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let summary: Summary;
  let workerExitCode: number;
  try {
    summary = await new Promise<Summary>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => reject(new Error('SQL parser deadline exceeded.')), timeoutMs);
      worker.once('message', (result: WorkerResponse) => {
        if ('error' in result) reject(new Error(result.error));
        else resolve(result.summary);
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error('SQL parser worker exited before producing a result (' + code + ').')));
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    await worker.terminate();
    workerExitCode = await exited;
  }
  return { ...summary, workerExitCode };
}
