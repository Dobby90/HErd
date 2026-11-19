import type { ErdDocument } from '@erd/model';
import type { Diagnostic } from '@erd/sql-contract';

export type DiagnosticTarget = { objectId: string; field?: string };
type Issue = Pick<Diagnostic, 'code' | 'message' | 'objectId'>;
type ObjectDetails = { name: string; editable: boolean; fields?: string[] };

const genericMessages: Readonly<Record<string, string>> = {
  'missing-table': '참조하는 테이블을 찾을 수 없습니다.',
  'missing-namespace': '참조하는 스키마를 찾을 수 없습니다.',
  'missing-enum': '참조하는 ENUM을 찾을 수 없습니다.',
  'invalid-column-reference': '컬럼이 존재하는지, 올바른 테이블에 속하는지 확인하세요.',
  'invalid-expression-reference': 'SQL 식이 참조하는 객체를 찾을 수 없습니다.',
  'unsafe-expression-deletion': '이 객체를 참조하는 SQL 식을 먼저 확인하세요.',
  'invalidated-expression': '이름이나 스키마 변경의 영향을 받을 수 있는 SQL 식입니다. 참조 이름을 확인하세요.',
};

function objectDetails(document: ErdDocument) {
  const { catalog } = document;
  const objects = new Map<string, ObjectDetails>();
  function add(item: { id: string; physicalName: string; logicalName?: string }, kind: string,
    { parentId, editable = true, fields }: { parentId?: string; editable?: boolean; fields?: string[] } = {}) {
    const name = item.physicalName.trim() ? item.physicalName : item.logicalName?.trim() || `이름 없는 ${kind}`;
    const parent = parentId ? objects.get(parentId)?.name : undefined;
    objects.set(item.id, { name: parent ? `${parent}.${name}` : name, editable, fields });
  }
  objects.set(document.id, { name: document.name, editable: false });
  for (const item of catalog.namespaces) add(item, '스키마');
  for (const item of catalog.tables) add(item, '테이블', { parentId: item.namespaceId });
  for (const item of catalog.columns) add(item, '컬럼', { parentId: item.tableId,
    fields: item.default?.invalidated ? ['DEFAULT SQL'] : undefined });
  for (const item of catalog.constraints) add(item, '제약', { parentId: item.tableId,
    fields: item.kind === 'check' && item.expression.invalidated ? ['CHECK SQL'] : undefined });
  for (const item of catalog.indexes) {
    const fields = item.keys.flatMap((key, index) => key.kind === 'expression' && key.expression.invalidated ? [indexExpressionLabel(index)] : []);
    if (item.predicate?.invalidated) fields.push('부분 인덱스 조건 SQL');
    add(item, '인덱스', { parentId: item.tableId, fields });
  }
  for (const item of catalog.enums) add(item, 'ENUM', { parentId: item.namespaceId, editable: false });
  for (const item of catalog.sequences) add(item, '시퀀스', { parentId: item.namespaceId, editable: false });
  for (const item of document.relationships) objects.set(item.id, { name: item.name, editable: true });
  for (const view of document.views) objects.set(view.id, { name: view.name, editable: false });
  return objects;
}

export const indexExpressionLabel = (index: number) => `인덱스 SQL 식 ${index + 1}`;

export function DiagnosticList({ document, issues, label, onOpen, className }: {
  document: ErdDocument; issues: readonly Issue[]; label: string; onOpen?(target: DiagnosticTarget): void; className?: string;
}) {
  if (!issues.length) return null;
  const objects = objectDetails(document);
  const seen = new Set<string>();
  return <ul className={className ? `diagnostics ${className}` : 'diagnostics'} aria-label={label}>
    {issues.flatMap(issue => {
      const { objectId, code } = issue;
      const object = objectId ? objects.get(objectId) : undefined;
      const message = genericMessages[code] ?? issue.message;
      const fields = code === 'invalidated-expression' && object?.fields?.length ? object.fields : [undefined];
      return fields.flatMap(field => {
        const key = JSON.stringify([code, objectId, message, field]);
        if (seen.has(key)) return [];
        seen.add(key);
        const name = field ? `${object?.name} · ${field}` : object?.name;
        return <li key={key}>
          {objectId && object?.editable && onOpen ? <button type="button" onClick={() => onOpen({ objectId, field })}>{name}</button>
            : name && <strong>{name}</strong>}
          <p>{message}</p>
        </li>;
      });
    })}
  </ul>;
}
