import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { freePort } from './tcp.js';

export async function withPostgres<T>(test: (cluster: {
  connectionString: string; query(sql: string, database?: string): string; dump(schema: string): string; restart(): void;
}) => Promise<T>): Promise<T> {
  const root = process.getuid?.() === 0;
  const postgresId = (flag: string) => Number(execFileSync('id', [flag, 'postgres'], { encoding: 'utf8' }).trim());
  const uid = root ? postgresId('-u') : process.getuid?.();
  const gid = root ? postgresId('-g') : process.getgid?.();
  const host = '127.0.0.1';
  const port = String(await freePort());
  const output = resolve('build');
  mkdirSync(output, { recursive: true });
  const base = mkdtempSync(resolve(output, 'pg-'));
  const data = resolve(base, 'data');
  const serverLog = resolve(base, 'server.log');
  const connection = ['-h', host, '-p', port, '-U', 'postgres', '-d', 'postgres'];
  const run = (name: string, args: string[], input?: string) => execFileSync(name, args, {
    uid, gid, input, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const start = () => {
    try {
      run('pg_ctl', ['-D', data, '-l', serverLog, '-w', 'start', '-o',
        "-c listen_addresses=" + host + " -c unix_socket_directories='' -p " + port]);
    } catch (error) {
      if (!existsSync(serverLog)) throw error;
      throw new Error('PostgreSQL startup failed:\n' + readFileSync(serverLog, 'utf8'), { cause: error });
    }
  };
  const stop = () => {
    try {
      run('pg_ctl', ['-D', data, '-w', 'status']);
    } catch (error) {
      if ((error as { status?: number }).status === 3) return;
      throw error;
    }
    run('pg_ctl', ['-D', data, '-w', '-m', 'fast', 'stop']);
  };
  let initialized = false;
  try {
    if (root && uid !== undefined && gid !== undefined) chownSync(base, uid, gid);
    chmodSync(base, 0o700);
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    initialized = true;
    start();
    return await test({
      connectionString: `postgresql://postgres@${host}:${port}/postgres`,
      query: (sql, database = 'postgres') => run('psql', [...connection.slice(0, -1), database, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], sql).trim(),
      dump: schema => run('pg_dump', [...connection, '--schema-only', '--schema=' + schema]),
      restart() { stop(); start(); },
    });
  } finally {
    try {
      if (initialized) stop();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
}
