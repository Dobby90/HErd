import { ApiError } from './api-error.js';

export function userSearch(value: unknown, minimum: number) {
  const query = value === undefined ? '' : typeof value === 'string' ? value.trim() : undefined;
  if (query === undefined || query.length < minimum || query.length > 100 || query.includes('\0')) {
    throw new ApiError(400, 'INVALID_USER_SEARCH', minimum
      ? `표시 이름 또는 로그인 아이디를 ${minimum}~100자로 입력하세요.` : '검색어는 100자까지 입력할 수 있습니다.');
  }
  return query;
}
