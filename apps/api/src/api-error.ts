import type { FastifyInstance } from 'fastify';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function configureErrors(api: FastifyInstance) {
  api.setErrorHandler((error: unknown, request, reply) => {
    const issue = error instanceof ApiError ? error
      : typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 413
        ? new ApiError(413, 'PAYLOAD_TOO_LARGE', '요청이 저장 용량 한도를 초과합니다.')
        : typeof error === 'object' && error && 'statusCode' in error && [400, 415].includes(Number(error.statusCode))
          ? new ApiError(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.')
          : new ApiError(500, 'INTERNAL_ERROR', '서버에서 요청을 처리하지 못했습니다.');
    if (issue.status >= 500) request.log.error({ requestId: request.id, code: issue.code }, 'Request failed');
    void reply.code(issue.status).send({ code: issue.code, message: issue.message, details: issue.details, requestId: request.id });
  });
  api.setNotFoundHandler(request => {
    throw new ApiError(404, 'NOT_FOUND', `요청한 리소스를 찾을 수 없습니다. (${request.method})`);
  });
}

export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'JSON 객체를 입력하세요.');
  }
  return body as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ApiError(400, 'INVALID_ID', '리소스 ID 형식이 올바르지 않습니다.');
  }
  return value;
}

export function revisionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new ApiError(400, 'INVALID_REVISION', '기준 리비전이 올바르지 않습니다.');
  }
  return value;
}
