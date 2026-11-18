import { parentPort, workerData } from 'node:worker_threads';
import parser from 'pgsql-parser';

function stringNodes(list = []) {
  return list.map(node => node.String?.sval).filter(value => typeof value === 'string');
}

function summarizeExpression(node) {
  if (node.FuncCall) {
    const { funcname, args = [] } = node.FuncCall;
    return { kind: 'function', name: stringNodes(funcname), arguments: args.map(summarizeExpression) };
  }
  if (node.TypeCast?.typeName && node.TypeCast.arg) {
    const { typeName, arg } = node.TypeCast;
    return {
      kind: 'cast', type: stringNodes(typeName.names), arrayDimensions: typeName.arrayBounds?.length ?? 0,
      operand: summarizeExpression(arg),
    };
  }
  if (node.A_ArrayExpr) {
    return { kind: 'array', elements: (node.A_ArrayExpr.elements ?? []).map(summarizeExpression) };
  }
  if (node.A_Expr?.kind === 'AEXPR_OP' && node.A_Expr.lexpr && node.A_Expr.rexpr) {
    const { name, lexpr, rexpr } = node.A_Expr;
    return { kind: 'operator', name: stringNodes(name), left: summarizeExpression(lexpr), right: summarizeExpression(rexpr) };
  }
  if (node.ColumnRef) return { kind: 'column', name: stringNodes(node.ColumnRef.fields) };
  if (node.A_Const?.sval) return { kind: 'literal', value: node.A_Const.sval.sval ?? '' };
  if (node.A_Const?.ival) return { kind: 'literal', value: node.A_Const.ival.ival ?? 0 };
  return { kind: 'other' };
}

function summarize(tree, maxStatements) {
  const statements = tree.stmts ?? [];
  if (!Number.isInteger(tree.version)) throw new Error('PostgreSQL AST did not contain an engine version.');
  if (statements.length > maxStatements) throw new Error('SQL statement limit exceeded.');
  const summary = {
    version: tree.version,
    statementKinds: [],
    tables: [],
    typeNames: [],
    columns: [],
    constraintKinds: [],
    constraintExpressions: [],
    compositeKeys: [],
  };

  for (const { stmt } of statements) {
    summary.statementKinds.push(...Object.keys(stmt));
    if (stmt.CreateStmt?.relation?.relname) summary.tables.push(stmt.CreateStmt.relation.relname);
  }

  const pending = [statements];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) pending.push(node[index]);
      continue;
    }
    if (node.TypeName) summary.typeNames.push(...stringNodes(node.TypeName.names));
    if (node.ColumnDef) {
      const { colname, typeName } = node.ColumnDef;
      summary.columns.push({ name: colname, array: Boolean(typeName?.arrayBounds?.length) });
      summary.typeNames.push(...stringNodes(typeName?.names));
    }
    if (node.Constraint) {
      const constraint = node.Constraint;
      summary.constraintKinds.push(constraint.contype);
      if (constraint.raw_expr && (constraint.contype === 'CONSTR_DEFAULT' || constraint.contype === 'CONSTR_CHECK')) {
        summary.constraintExpressions.push({
          kind: constraint.contype === 'CONSTR_DEFAULT' ? 'default' : 'check',
          expression: summarizeExpression(constraint.raw_expr),
        });
      }
      const columns = stringNodes(constraint.keys ?? constraint.fk_attrs);
      if (columns.length > 1) {
        summary.compositeKeys.push({ columns, referencedColumns: stringNodes(constraint.pk_attrs) });
      }
    }
    const children = Object.values(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return summary;
}

try {
  const tree = await parser.parse(workerData.sql);
  parentPort.postMessage({ summary: summarize(tree, workerData.maxStatements) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
