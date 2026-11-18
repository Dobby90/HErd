import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { SampleApp } from '../apps/web/src/sample-app.js';

it('renders the validated sample with both views and all four tables', () => {
  const html = renderToStaticMarkup(<SampleApp />);
  for (const text of ['구조 검증 통과', 'users', 'orders', 'order_items', 'products', '주문 전체', '상품 연결']) {
    expect(html).toContain(text);
  }
});

it('answers health requests without a database connection', async () => {
  const { api } = createApi();
  try {
    const response = await api.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  } finally {
    await api.close();
  }
});
