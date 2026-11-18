import { documentExpressions, validateDocumentStructure } from '@erd/model';
import type { ErdDocument, SqlTarget } from '@erd/model';
import type {
  Diagnostic, DialectCapabilities, GenerateRequest, GenerateResult, ParseRequest, ParseResult, SqlDialect,
} from '@erd/sql-contract';
import { documentForSelection } from './selection.js';

export class DialectRegistry {
  readonly #adapters = new Map<string, SqlDialect>();

  register(adapter: SqlDialect) {
    const { id } = adapter.metadata;
    if (this.#adapters.has(id)) throw new Error('Duplicate SQL dialect: ' + id);
    this.#adapters.set(id, adapter);
  }

  get(id: string): SqlDialect | undefined {
    return this.#adapters.get(id);
  }
}

type Resolution = { adapter: SqlDialect } | { diagnostic: Diagnostic };

function uncertified(target: SqlTarget): Diagnostic {
  return { code: 'uncertified-engine-version', severity: 'error', message: target.dialectId + ' ' + target.engineVersion + ' is not certified.' };
}

export class SqlService {
  constructor(private readonly registry: DialectRegistry) {}

  #resolve(target: SqlTarget): Resolution {
    const adapter = this.registry.get(target.dialectId);
    if (!adapter) return { diagnostic: { code: 'unregistered-dialect', severity: 'error', message: 'Unknown SQL dialect: ' + target.dialectId } };
    const profile = adapter.metadata.profiles.find(candidate => candidate.version === target.engineVersion);
    return profile?.status === 'certified' ? { adapter } : { diagnostic: uncertified(target) };
  }

  capabilities(target: SqlTarget): DialectCapabilities | { diagnostics: Diagnostic[] } {
    const resolved = this.#resolve(target);
    if ('diagnostic' in resolved) return { diagnostics: [resolved.diagnostic] };
    return resolved.adapter.capabilities(target);
  }

  validate(document: ErdDocument): Diagnostic[] {
    const resolved = this.#resolve(document.target);
    if ('diagnostic' in resolved) return [resolved.diagnostic];
    return resolved.adapter.validate(document, { target: document.target });
  }

  async parse(request: ParseRequest): Promise<ParseResult> {
    const resolved = this.#resolve(request.target);
    if ('diagnostic' in resolved) return { status: 'blocked', diagnostics: [resolved.diagnostic] };
    return resolved.adapter.parse(request);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const blocked = (diagnostics: Diagnostic[]): GenerateResult => ({ status: 'blocked', diagnostics, dependencies: [] });
    const { target, document } = request;
    const resolved = this.#resolve(target);
    if ('diagnostic' in resolved) return blocked([resolved.diagnostic]);
    if (target.dialectId !== document.target.dialectId || target.engineVersion !== document.target.engineVersion) {
      return blocked([{ code: 'target-mismatch', severity: 'error', message: 'Generation target must match the document target.' }]);
    }
    const structural = validateDocumentStructure(document);
    if (structural.length) return blocked(structural);

    const diagnostics: Diagnostic[] = [];
    let validationDocument = document;
    if (request.tableIds !== undefined) {
      const tableIds = new Set(document.catalog.tables.map(table => table.id));
      for (const tableId of request.tableIds) {
        if (!tableIds.has(tableId)) {
          diagnostics.push({ code: 'unknown-generation-table', severity: 'error', objectId: tableId, message: 'Selected table does not exist.' });
        }
      }
      if (diagnostics.length) return blocked(diagnostics);
      validationDocument = documentForSelection(document, request.tableIds);
    }

    const { adapter } = resolved;
    const checkExtension = (extension: { namespace: string; version: number }, objectId: string) => {
      if (!adapter.understandsExtension?.(extension.namespace, extension.version)) {
        diagnostics.push({
          code: 'unknown-extension', severity: 'error', feature: extension.namespace, objectId,
          message: 'Cannot verify extension version ' + extension.version + '.',
        });
      }
    };
    for (const extension of validationDocument.extensions) checkExtension(extension, validationDocument.id);
    for (const column of validationDocument.catalog.columns) {
      for (const attributes of column.type.attributes ?? []) checkExtension(attributes, column.id);
    }
    for (const { ownerId, expression } of documentExpressions(validationDocument)) {
      if (expression.invalidated) {
        diagnostics.push({
          code: 'invalidated-expression', severity: 'error', objectId: ownerId, message: 'Review the preserved SQL expression.',
        });
      }
      if (expression.dialectId !== target.dialectId || expression.engineVersion !== target.engineVersion) {
        diagnostics.push({
          code: 'expression-target-mismatch', severity: 'error', objectId: ownerId, message: 'SQL expression target differs from the document target.',
        });
      }
    }
    if (diagnostics.length) return blocked(diagnostics);

    const semantic = adapter.validate(validationDocument, { target });
    if (semantic.some(diagnostic => diagnostic.severity === 'error')) return blocked(semantic);
    const result = await adapter.generate(request);
    const combined = [...semantic, ...result.diagnostics];
    if (result.status !== 'generated') {
      return { status: result.status, dependencies: result.dependencies, diagnostics: combined };
    }
    if (combined.some(diagnostic => diagnostic.severity === 'error')) {
      return { status: 'blocked', dependencies: result.dependencies, diagnostics: combined };
    }
    return { status: 'generated', sql: result.sql, dependencies: result.dependencies, diagnostics: combined };
  }
}
