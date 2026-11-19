import type { PoolClient } from 'pg';
import { ApiError } from './api-error.js';

export async function lockMembershipChanges(client: PoolClient) {
  // Account suspension and membership changes share the active-owner invariant.
  await client.query('SELECT pg_advisory_xact_lock(171504033)');
}

export async function requireActiveAccount(client: PoolClient, id: string) {
  const { rows: [account] } = await client.query<{ isAdmin: boolean }>(
    'SELECT is_admin AS "isAdmin" FROM users WHERE id = $1 AND disabled_at IS NULL FOR SHARE', [id]);
  if (!account) throw new ApiError(403, 'ACCOUNT_DISABLED', '비활성화된 계정입니다. 서비스 관리자에게 문의하세요.');
  return account;
}
