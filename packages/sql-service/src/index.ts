import { documentExpressions, validateDocumentStructure } from '@erd/model';
import type { ErdDocument, SqlTarget } from '@erd/model';
import type {
  Diagnostic, DialectCapabilities, EngineProfile, GenerateRequest, GenerateResult, ParseRequest, ParseResult, SqlDialect,
} from '@erd/sql-contract';

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

type Resolution = { adapter: SqlDialect; profile: EngineProfile } | { diagnostic: Diagnostic };

function uncertified(target: SqlTarget): Diagnostic {
  return { code: 'uncertified-engine-version', severity: 'error', message: target.dialectId + ' ' + target.engineVersion + ' is not certified.' };
}

function unavailable(capabilities: DialectCapabilities, direction: 'import' | 'export') {
  const entries = Object.values(capabilities);
  return entries.length > 0 && entries.every(feature => feature[direction] !== 'supported');
}

export class SqlService {
  constructor(private readonly registry: DialectRegistry) {}

  #resolve(target: SqlTarget): Resolution {
    const adapter = this.registry.get(target.dialectId);
    if (!adapter) return { diagnostic: { code: 'unregistered-dialect', severity: 'error', message: 'Unknown SQL dialect: ' + target.dialectId } };
    const profile = adapter.metadata.profiles.find(candidate => candidate.version === target.engineVersion);
    return profile ? { adapter, profile } : { diagnostic: uncertified(target) };
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
    const { adapter, profile } = resolved;
    if (profile.status === 'certified') return adapter.parse(request);
    if (unavailable(adapter.capabilities(request.target), 'import')) {
      const result = await adapter.parse(request);
      if (result.status === 'not-implemented') return result;
    }
    return { status: 'blocked', diagnostics: [uncertified(request.target)] };
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

    const { adapter, profile } = resolved;
    const diagnostics: Diagnostic[] = [];
    const checkExtension = (extension: { namespace: string; version: number }, objectId: string) => {
      if (!adapter.understandsExtension?.(extension.namespace, extension.version)) {
        diagnostics.push({
          code: 'unknown-extension', severity: 'error', feature: extension.namespace, objectId,
          message: 'Cannot verify extension version ' + extension.version + '.',
        });
      }
    };
    for (const extension of document.extensions) checkExtension(extension, document.id);
    for (const column of document.catalog.columns) {
      for (const attributes of column.type.attributes ?? []) checkExtension(attributes, column.id);
    }
    for (const { ownerId, expression } of documentExpressions(document)) {
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
    for (const tableId of request.tableIds ?? []) {
      if (!document.catalog.tables.some(table => table.id === tableId)) {
        diagnostics.push({ code: 'unknown-generation-table', severity: 'error', objectId: tableId, message: 'Selected table does not exist.' });
      }
    }
    if (diagnostics.length) return blocked(diagnostics);

    if (profile.status === 'certified') {
      const semantic = adapter.validate(document, { target });
      if (semantic.some(diagnostic => diagnostic.severity === 'error')) return blocked(semantic);
      const result = await adapter.generate(request);
      const combined = [...semantic, ...result.diagnostics];
      if (result.status === 'generated' && combined.some(diagnostic => diagnostic.severity === 'error')) {
        return { status: 'blocked', dependencies: result.dependencies, diagnostics: combined };
      }
      return { ...result, diagnostics: combined };
    }
    if (unavailable(adapter.capabilities(target), 'export')) {
      const result = await adapter.generate(request);
      if (result.status === 'not-implemented') return result;
    }
    return blocked([uncertified(target)]);
  }
}
