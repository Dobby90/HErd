import type { Diagnostic, SqlDialect } from '@erd/sql-contract';
import { postgresqlEditor, postgresqlMetadata } from './ui.js';

function notImplemented(feature: 'import' | 'export'): Diagnostic[] {
  return [{
    code: 'not-implemented', severity: 'error', feature,
    message: 'PostgreSQL ' + feature + ' is planned for a later stage.',
  }];
}

export const postgresqlDialect: SqlDialect = {
  metadata: postgresqlMetadata,
  capabilities: postgresqlEditor.capabilities,
  validate: postgresqlEditor.validate,
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
