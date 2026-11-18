import type { ErdDocument, SqlTarget } from '@erd/model';

export interface User {
  id: string;
  displayName: string;
}

export interface Identity {
  user: User | null;
  csrfToken: string | null;
  auth: { oidc: boolean; development: boolean };
}

export interface Project {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  documentCount: number;
  updatedAt: string;
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
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
    throw new ApiFailure(response.status, problem.code ?? 'REQUEST_FAILED',
      problem.message ?? '서버 요청을 처리하지 못했습니다.', problem.requestId);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
