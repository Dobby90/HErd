import type { Page } from 'playwright-core';

export async function renameDocument(page: Page, name: string) {
  await page.getByRole('button', { name: '문서 제목 변경', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '문서 제목 변경' });
  await dialog.getByLabel('문서 제목', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '제목 적용', exact: true }).click();
}

export async function openExport(page: Page, format: 'DDL' | '이미지') {
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await page.getByRole('button', { name: `${format} 내보내기`, exact: true }).click();
}
