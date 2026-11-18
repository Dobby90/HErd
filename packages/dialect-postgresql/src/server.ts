import { documentExpressions, validateDocumentStructure } from '@erd/model';
import type { SqlDialect } from '@erd/sql-contract';
import { preparePostgresqlExport } from './export.js';
import { importPostgresql } from './import.js';
import { postgresqlEditor, postgresqlMetadata } from './ui.js';

export const postgresqlDialect: SqlDialect = {
  metadata: postgresqlMetadata,
  capabilities: postgresqlEditor.capabilities,
  validate: postgresqlEditor.validate,
  prepareGenerate: preparePostgresqlExport,
  parse: importPostgresql,
  async generate(request) {
    const { target, document } = request;
    if (target.engineVersion !== '17' || target.dialectId !== 'postgresql' ||
        target.dialectId !== document.target.dialectId || target.engineVersion !== document.target.engineVersion) {
      return { status: 'blocked', dependencies: [], diagnostics: [{ code: 'target-mismatch', severity: 'error', message: '문서의 PostgreSQL 17 대상을 사용하세요.' }] };
    }
    const structure = validateDocumentStructure(document);
    if (structure.length) return { status: 'blocked', dependencies: [], diagnostics: structure };
    if (request.tableIds !== undefined && (!request.tableIds.length ||
        request.tableIds.some(id => !document.catalog.tables.some(table => table.id === id)))) {
      return { status: 'blocked', dependencies: [], diagnostics: [{ code: 'invalid-generation-selection', severity: 'error', message: '문서의 테이블을 선택하세요.' }] };
    }
    const plan = await preparePostgresqlExport(request);
    const diagnostics = [...postgresqlEditor.validate(plan.document, { target }), ...plan.diagnostics];
    const expressions = [...documentExpressions(plan.document)];
    if (expressions.some(({ expression }) => expression.engineVersion !== target.engineVersion || expression.dialectId !== target.dialectId)) {
      diagnostics.push({ code: 'expression-target-mismatch', severity: 'error', message: 'SQL 식의 대상 버전이 문서와 다릅니다.' });
    }
    if ([plan.document, ...Object.values(plan.document.catalog).flat()].some(item => item.extensions?.length) ||
        plan.document.catalog.columns.some(item => item.type.attributes?.length)) {
      diagnostics.push({ code: 'unknown-extension', severity: 'error', message: '지원하는 모델 속성만 내보낼 수 있습니다.' });
    }
    return diagnostics.length ? { status: 'blocked', dependencies: plan.dependencies, diagnostics } : plan.generate();
  },
};
