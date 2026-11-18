import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { inspectPostgresql } from '../packages/dialect-postgresql/src/parser.js';
import { schemaDdl } from '../packages/test-fixtures/src/postgresql.js';

it('executes fixture DDL on PostgreSQL 17 and inspects its actual schema-only dump', async () => {
  const rootUser = process.getuid?.() === 0;
  const postgresId = (flag: string) => Number(execFileSync('id', [flag, 'postgres'], { encoding: 'utf8' }).trim());
  const uid = rootUser ? postgresId('-u') : process.getuid?.();
  const gid = rootUser ? postgresId('-g') : process.getgid?.();
  const output = resolve('build');
  mkdirSync(output, { recursive: true });
  const base = mkdtempSync(resolve(output, 'pg-stage1-'));
  const data = resolve(base, 'data');
  const socket = base;
  const port = '55432';
  const connection = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres'];
  const run = (name: string, args: string[], input?: string) => execFileSync(name, args, {
    uid, gid, input, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let initialized = false;
  try {
    if (rootUser && uid !== undefined && gid !== undefined) chownSync(base, uid, gid);
    chmodSync(base, 0o700);
    run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    initialized = true;
    run('pg_ctl', ['-D', data, '-l', resolve(base, 'server.log'), '-w', 'start', '-o',
      '-c listen_addresses= -c unix_socket_directories=' + quote(socket) + ' -p ' + port]);
    const query = (sql: string) => run('psql', [...connection, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], sql).trim();
    expect(query('SHOW server_version_num')).toMatch(/^17\d{4}$/);
    query(schemaDdl);
    expect(query("SELECT count(*) FROM pg_tables WHERE schemaname = 'stage1'")).toBe('3');
    expect(query("SELECT count(*) FROM pg_constraint WHERE connamespace = 'stage1'::regnamespace AND contype = 'f'")).toBe('1');
    expect(query("SELECT count(*) FROM pg_sequences WHERE schemaname = 'stage1'")).toBe('2');
    expect(query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stage1' AND is_identity = 'YES'")).toBe('1');
    expect(query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stage1' AND data_type IN ('jsonb', 'uuid', 'ARRAY')")).toBe('3');
    const dump = run('pg_dump', [...connection, '--schema-only', '--schema=stage1']);
    const lines = dump.split(/\r?\n/);
    const meta = lines.filter(line => line.startsWith('\\'));
    expect(meta.map(line => line.split(/\s/, 1)[0])).toEqual(['\\restrict', '\\unrestrict']);
    await expect(inspectPostgresql(dump)).rejects.toThrow(/syntax error/i);
    const sqlOnly = lines.filter(line => !/^\\(?:un)?restrict\s/.test(line)).join('\n');
    const result = await inspectPostgresql(sqlOnly);
    expect(result.tables).toEqual(expect.arrayContaining(['Users', 'Orders', 'OrderItems']));
    expect(result.statementKinds).toEqual(expect.arrayContaining(['VariableSetStmt', 'AlterTableStmt', 'CreateEnumStmt', 'CreateSeqStmt', 'IndexStmt']));
  } finally {
    try {
      if (initialized) {
        try {
          run('pg_ctl', ['-D', data, '-w', 'status']);
        } catch (error) {
          if ((error as { status?: number }).status !== 3) throw error;
          initialized = false;
        }
        if (initialized) run('pg_ctl', ['-D', data, '-w', '-m', 'immediate', 'stop']);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
