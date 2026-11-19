import type { ErdDocument, SqlTarget } from '@erd/model';

export interface User {
  id: string;
  displayName: string;
  isAdmin: boolean;
}

export interface Identity {
  user: User | null;
  csrfToken: string | null;
  auth: { oidc: boolean; development: boolean; local: boolean };
}

export interface Project {
  id: string;
  createdBy: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  documentCount: number;
  updatedAt: string;
}

export type ProjectRole = Project['role'];
export interface ProjectAccount {
  id: string;
  displayName: string;
  username: string | null;
}

export interface ProjectMember extends ProjectAccount {
  disabled: boolean;
  role: ProjectRole;
}

export interface SnapshotInfo {
  id: string;
  kind: 'manual' | 'checkpoint' | 'before-import' | 'before-restore';
  sourceRevision: number;
  author: string;
  createdAt: string;
  description: string;
}

export interface SnapshotDetail extends SnapshotInfo {
  document: ErdDocument;
}

export interface SavedRevision {
  revision: number;
  updatedAt: string;
}

export interface ServerDocument extends SavedRevision {
  document: ErdDocument;
}

export interface DocumentSummary extends SavedRevision {
  id: string;
  title: string;
  target: SqlTarget;
}

export interface Mutation {
  baseRevision: number;
  mutationId: string;
  document: ErdDocument;
}

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, options: {
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';
  body?: unknown;
  csrf?: string | null;
} = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api' + path, {
      method: options.method ?? 'GET', cache: 'no-store', credentials: 'same-origin',
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.csrf && { 'X-CSRF-Token': options.csrf }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiFailure(0, 'OFFLINE', '서버에 연결하지 못했습니다. 연결이 돌아오면 다시 시도합니다.');
  }
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { code?: string; message?: string; requestId?: string };
    if ([401, 403, 404].includes(response.status) && /^\/(erds\/|sql\/jobs\/|projects\/[^/]+\/)/.test(path)) {
      window.dispatchEvent(new Event('herd:check-project-access'));
    }
    throw new ApiFailure(response.status, problem.code ?? 'REQUEST_FAILED',
      problem.message ?? '서버 요청을 처리하지 못했습니다.', problem.requestId);
  }
  return response.status === 204 || options.method === 'HEAD' ? undefined as T : await response.json() as T;
}
