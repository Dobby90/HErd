import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ErdDocument } from '@erd/model';
import type { GenerateRequest, SqlJob, SqlJobOutput } from '@erd/sql-contract';
import type { Pool } from 'pg';
import type { SqlJobSettings } from './config.js';

const stopped = (code: string, message: string): SqlJobOutput => ({
  diagnostics: [{ code, message, severity: 'error' }], dependencies: [],
});
type Completion = { state: 'succeeded' | 'failed'; output: SqlJobOutput };
type Claimed = Pick<SqlJob, 'id' | 'options' | 'target'> & { snapshot: ErdDocument };
const workerFailure: Completion = { state: 'failed', output: stopped('SQL_WORKER_ERROR', 'SQL 작업이 완료되지 않았습니다.') };
const workerTimeout: Completion = { state: 'failed', output: stopped('SQL_JOB_TIMEOUT', 'SQL 작업의 실행 제한 시간을 초과했습니다.') };

async function generate(job: Claimed, timeoutMs: number, signal: AbortSignal): Promise<Completion | undefined> {
  if (signal.aborted) return;
  const source = new URL('./sql-worker-dev.mjs', import.meta.url);
  const worker = new Worker(existsSync(source) ? source : new URL('./sql-worker.js', import.meta.url), {
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    workerData: {
      request: { document: job.snapshot, target: job.target, tableIds: job.options.tableIds,
        options: { includeComments: job.options.includeComments } } satisfies GenerateRequest,
      previewOnly: job.options.previewOnly ?? false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Completion | undefined>(resolve => {
      abort = () => resolve(undefined);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(() => resolve(workerTimeout), timeoutMs);
      worker.once('message', (result: Completion) => resolve(result));
      worker.once('error', () => resolve(workerFailure));
      worker.once('exit', () => resolve(workerFailure));
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

export class SqlQueue {
  private initialized?: Promise<void>;
  private dispatch?: Promise<void>;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private cleanup?: Promise<unknown>;
  private requested = false;
  private closed = false;
  private readonly running = new Map<string, { controller: AbortController; task: Promise<void> }>();

  constructor(private readonly pool: Pool, readonly settings: SqlJobSettings, private readonly onError: () => void) {}

  ready() {
    this.initialized ??= this.reset().catch(error => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async reset() {
    await this.pool.query(`UPDATE sql_jobs SET state = 'failed', snapshot = NULL, output = $1,
      expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE state IN ('queued', 'running')`,
    [JSON.stringify(stopped('SQL_JOB_RESTARTED', 'API가 재시작되었습니다. SQL 작업을 다시 요청하세요.')), this.settings.ttlMs]);
    await this.pool.query('DELETE FROM sql_jobs WHERE expires_at <= clock_timestamp()');
    if (this.closed) return;
    this.expiryTimer = setInterval(() => {
      if (!this.cleanup) this.cleanup = this.maintain()
        .catch(this.onError).finally(() => { this.cleanup = undefined; });
      this.wake();
    }, Math.min(this.settings.ttlMs, 60_000));
    this.expiryTimer.unref();
  }

  private async maintain() {
    await this.pool.query(`UPDATE sql_jobs SET state = 'failed', snapshot = NULL, output = $1,
      expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE state = 'running'
      AND started_at <= clock_timestamp() - $3 * interval '1 millisecond'`,
    [JSON.stringify(workerTimeout.output), this.settings.ttlMs, this.settings.timeoutMs * 2]);
    await this.pool.query('DELETE FROM sql_jobs WHERE expires_at <= clock_timestamp()');
  }

  wake() {
    if (this.closed) return;
    this.requested = true;
    if (this.dispatch) return;
    this.dispatch = this.drain().catch(this.onError).finally(() => {
      this.dispatch = undefined;
      if (this.requested) this.wake();
    });
  }

  private async drain() {
    while (this.requested && !this.closed) {
      this.requested = false;
      while (!this.closed && this.running.size < this.settings.workers) {
        const { rows: [job] } = await this.pool.query<Claimed>(`WITH next AS (
          SELECT id FROM sql_jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE sql_jobs j SET state = 'running', started_at = clock_timestamp() FROM next WHERE j.id = next.id
          RETURNING j.id, j.options, j.target, j.snapshot`);
        if (!job || this.closed) break;
        const controller = new AbortController();
        const task = this.execute(job, controller.signal).catch(this.onError).finally(() => {
          this.running.delete(job.id);
          this.wake();
        });
        this.running.set(job.id, { controller, task });
      }
    }
  }

  private async execute(job: Claimed, signal: AbortSignal) {
    const { rowCount } = await this.pool.query("SELECT 1 FROM sql_jobs WHERE id = $1 AND state = 'running'", [job.id]);
    if (!rowCount || signal.aborted) return;
    const outcome = await generate(job, this.settings.timeoutMs, signal).catch(() => workerFailure);
    if (!outcome || signal.aborted) return;
    await this.pool.query(`UPDATE sql_jobs SET state = $2, snapshot = NULL, output = $3,
      expires_at = clock_timestamp() + $4 * interval '1 millisecond' WHERE id = $1 AND state = 'running'`,
    [job.id, outcome.state, JSON.stringify(outcome.output), this.settings.ttlMs]);
  }

  cancel(id: string) {
    this.running.get(id)?.controller.abort();
  }

  async close() {
    this.closed = true;
    clearInterval(this.expiryTimer);
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.allSettled([this.initialized, this.dispatch, this.cleanup, ...[...this.running.values()].map(item => item.task)]);
  }
}
