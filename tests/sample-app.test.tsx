import { renderToStaticMarkup } from 'react-dom/server';
import { sampleDocument } from '@erd/test-fixtures';
import { expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import { DocumentEditor } from '../apps/web/src/editor.js';

it('opens the editor on the validated sample with both views and all four tables', () => {
  const html = renderToStaticMarkup(<DocumentEditor readOnly session={{ document: sampleDocument, diagnostics: [],
    status: { text: '읽기 전용' }, canUndo: false, canRedo: false, run: () => false, step: () => undefined }} />);
  for (const text of ['읽기 전용', '속성', 'users', 'orders', 'order_items', 'products', '주문 전체', '상품 연결']) {
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
