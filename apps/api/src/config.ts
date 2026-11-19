export interface OidcSettings {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  allowHttp: boolean;
}

export interface AuthSettings {
  origin: string;
  devLogin: boolean;
  localAuth?: boolean;
  oidc?: OidcSettings;
}

export const defaultDocumentLimits = { bytes: 20 * 1024 * 1024, tables: 1000, columns: 20_000, relationships: 5000 };
export type DocumentLimits = typeof defaultDocumentLimits;
export const defaultCheckpointSettings = { intervalMs: 600_000, keep: 50 };
export type CheckpointSettings = typeof defaultCheckpointSettings;
export const defaultSqlJobSettings = { timeoutMs: 10_000, ttlMs: 10 * 60_000, userLimit: 2, workers: 2 };
export const defaultSqlInputBytes = 5 * 1024 * 1024;
export const defaultSqlActive = 64;
export const defaultSqlHeapMb = 256;
export type SqlJobSettings = typeof defaultSqlJobSettings & { maxInputBytes?: number; maxActive?: number; heapMb?: number };

function readLimit(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_479_551) throw new Error(key + ' must be a positive integer.');
  return value;
}

const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

export function readConfig(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production';
  const local = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const devLogin = env.ERD_DEV_LOGIN === '1';
  const localAuth = env.ERD_LOCAL_AUTH === '1';
  if (devLogin && !local) throw new Error('ERD_DEV_LOGIN requires NODE_ENV=development or test.');
  const configuredOidc = env.OIDC_ISSUER || env.OIDC_CLIENT_ID || env.OIDC_CLIENT_SECRET;
  if (!env.DATABASE_URL) {
    if (devLogin || localAuth || configuredOidc || production) throw new Error('DATABASE_URL is required for server authentication.');
    return undefined;
  }
  if (production && !env.APP_ORIGIN) throw new Error('APP_ORIGIN is required in production.');
  const webOrigin = new URL(env.APP_ORIGIN ?? 'http://127.0.0.1:' + (env.WEB_PORT ?? '5173'));
  if (webOrigin.href !== webOrigin.origin + '/' || webOrigin.username || webOrigin.password ||
      (webOrigin.protocol !== 'https:' && !(webOrigin.protocol === 'http:' && !production && loopback(webOrigin)))) {
    throw new Error('APP_ORIGIN must be an HTTPS origin or an HTTP loopback origin in development.');
  }
  if (devLogin && !loopback(webOrigin)) throw new Error('ERD_DEV_LOGIN requires a loopback APP_ORIGIN.');
  let oidc: OidcSettings | undefined;
  if (configuredOidc) {
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw new Error('OIDC configuration is incomplete.');
    const issuer = new URL(env.OIDC_ISSUER);
    const allowHttp = local && loopback(webOrigin) && loopback(issuer);
    if (issuer.username || issuer.password || issuer.hash || issuer.search ||
        (issuer.protocol !== 'https:' && !(allowHttp && issuer.protocol === 'http:'))) {
      throw new Error('OIDC_ISSUER must use HTTPS or an HTTP loopback issuer in development.');
    }
    oidc = { issuer, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, allowHttp };
  }
  if (production && !oidc && !localAuth) throw new Error('Local authentication or OIDC is required in production.');
  const limits = {
    bytes: readLimit(env, 'ERD_MAX_DOCUMENT_BYTES', defaultDocumentLimits.bytes),
    tables: readLimit(env, 'ERD_MAX_TABLES', defaultDocumentLimits.tables),
    columns: readLimit(env, 'ERD_MAX_COLUMNS', defaultDocumentLimits.columns),
    relationships: readLimit(env, 'ERD_MAX_RELATIONSHIPS', defaultDocumentLimits.relationships),
  };
  const jobs = {
    timeoutMs: readLimit(env, 'SQL_JOB_TIMEOUT_MS', defaultSqlJobSettings.timeoutMs),
    ttlMs: readLimit(env, 'SQL_JOB_TTL_MS', defaultSqlJobSettings.ttlMs),
    userLimit: readLimit(env, 'SQL_JOB_USER_LIMIT', defaultSqlJobSettings.userLimit),
    workers: readLimit(env, 'SQL_JOB_WORKERS', defaultSqlJobSettings.workers),
    maxInputBytes: readLimit(env, 'SQL_JOB_MAX_INPUT_BYTES', defaultSqlInputBytes),
    maxActive: readLimit(env, 'SQL_JOB_MAX_ACTIVE', defaultSqlActive),
    heapMb: readLimit(env, 'SQL_WORKER_HEAP_MB', defaultSqlHeapMb),
  };
  const checkpoints = {
    intervalMs: readLimit(env, 'ERD_CHECKPOINT_INTERVAL_MS', defaultCheckpointSettings.intervalMs),
    keep: readLimit(env, 'ERD_CHECKPOINT_KEEP', defaultCheckpointSettings.keep),
  };
  return { databaseUrl: env.DATABASE_URL, auth: { origin: webOrigin.origin, devLogin, localAuth, oidc }, limits, jobs, checkpoints };
}
