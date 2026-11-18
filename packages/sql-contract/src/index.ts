import type { Catalog, ErdDocument, SqlTarget } from '@erd/model';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  feature?: string;
  objectId?: string;
  location?: { offset: number; length?: number; line?: number; column?: number };
  help?: string;
}

export interface EngineProfile {
  version: string;
  status: 'certified' | 'candidate';
}

export interface DialectMetadata {
  id: string;
  name: string;
  adapterVersion: string;
  profiles: readonly EngineProfile[];
}

export type Capability = 'supported' | 'not-implemented' | 'unsupported';
export type DialectCapabilities = Readonly<Record<string, Readonly<Record<'model' | 'edit' | 'import' | 'export', Capability>>>>;

export interface ValidationContext { target: SqlTarget }

export interface ParseLimits { maxBytes?: number; maxStatements?: number; timeoutMs?: number }
export interface ParseRequest {
  sql: string;
  target: SqlTarget;
  defaultNamespace: string;
  limits?: ParseLimits;
  signal?: AbortSignal;
}
export interface StatementResult {
  ordinal: number;
  status: 'converted' | 'unsupported' | 'invalid';
  location?: Diagnostic['location'];
}
export type ParseResult =
  | { status: 'blocked' | 'not-implemented'; diagnostics: Diagnostic[]; profile?: EngineProfile }
  | { status: 'parsed'; catalog: Catalog; diagnostics: Diagnostic[]; profile: EngineProfile;
      statements: StatementResult[]; losses: Diagnostic[] };

export interface GenerateRequest {
  document: ErdDocument;
  target: SqlTarget;
  tableIds?: readonly string[];
  options?: { includeComments?: boolean };
}
export interface Dependency { kind: keyof Catalog; objectId: string }
export type GenerateResult = {
  dependencies: Dependency[];
  diagnostics: Diagnostic[];
} & ({ status: 'generated'; sql: string } | { status: 'blocked' | 'not-implemented'; sql?: never });

export interface SqlDialect {
  metadata: DialectMetadata;
  capabilities(target: SqlTarget): DialectCapabilities;
  validate(document: ErdDocument, context: ValidationContext): Diagnostic[];
  understandsExtension?(namespace: string, version: number): boolean;
  parse(request: ParseRequest): Promise<ParseResult>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
