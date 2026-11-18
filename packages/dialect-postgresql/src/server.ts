import type { Diagnostic, SqlDialect } from '@erd/sql-contract';
import { postgresqlCapabilities, postgresqlMetadata } from './ui.js';

function notImplemented(feature: 'import' | 'export'): Diagnostic[] {
  return [{
    code: 'not-implemented', severity: 'error', feature,
    message: 'PostgreSQL ' + feature + ' is planned for a later stage.',
  }];
}

export const postgresqlDialect: SqlDialect = {
  metadata: postgresqlMetadata,
  capabilities: () => postgresqlCapabilities,
  validate(document) {
    const diagnostics: Diagnostic[] = [];
    const primaryTables = new Set<string>();
    const indexes = new Map(document.catalog.indexes.map(index => [index.id, index]));
    for (const constraint of document.catalog.constraints) {
      if (constraint.kind === 'pk') {
        if (primaryTables.has(constraint.tableId)) {
          diagnostics.push({
            code: 'postgresql-multiple-primary-keys', severity: 'error', objectId: constraint.id,
            message: 'PostgreSQL allows one primary key per table.',
          });
        }
        primaryTables.add(constraint.tableId);
      }
      if (constraint.kind === 'fk' && constraint.targetKey.kind === 'index' && indexes.get(constraint.targetKey.id)?.predicate) {
        diagnostics.push({
          code: 'postgresql-partial-reference-index', severity: 'error', objectId: constraint.id,
          message: 'A partial unique index cannot back a PostgreSQL foreign key.',
        });
      }
    }
    return diagnostics;
  },
  async parse(request) {
    return {
      status: 'not-implemented', diagnostics: notImplemented('import'),
      profile: postgresqlMetadata.profiles.find(profile => profile.version === request.target.engineVersion),
    };
  },
  async generate() {
    return { status: 'not-implemented', diagnostics: notImplemented('export'), dependencies: [] };
  },
};
