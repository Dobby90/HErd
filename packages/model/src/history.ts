import { applyCommand } from './lifecycle.js';
import type { DocumentCommand } from './lifecycle.js';
import type { ErdDocument } from './schema.js';

export interface DocumentHistory {
  present: ErdDocument;
  past: readonly ErdDocument[];
  future: readonly ErdDocument[];
}

export function documentHistory(document: ErdDocument): DocumentHistory {
  return { present: document, past: [], future: [] };
}

export function commitDocument(history: DocumentHistory, command: DocumentCommand) {
  const result = applyCommand(history.present, command);
  if (!result.applied || JSON.stringify(result.document) === JSON.stringify(history.present)) {
    return { history, diagnostics: result.diagnostics };
  }
  return {
    history: { present: result.document, past: [...history.past, history.present], future: [] },
    diagnostics: result.diagnostics,
  };
}

export function stepHistory(history: DocumentHistory, direction: 'undo' | 'redo'): DocumentHistory {
  const { present, past, future } = history;
  if (direction === 'undo') {
    const previous = past.at(-1);
    return previous ? { present: previous, past: past.slice(0, -1), future: [present, ...future] } : history;
  }
  const next = future[0];
  return next ? { present: next, past: [...past, present], future: future.slice(1) } : history;
}
