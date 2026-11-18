import { deserializeDocument, serializeDocument } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { Mutation } from './project-api.js';

interface StoredMutation extends Omit<Mutation, 'document'> {
  serialized: string;
}

export interface ServerDraft {
  key: string;
  owner: string;
  documentId: string;
  baseRevision: number;
  updatedAt: string;
  serialized: string;
  pending?: StoredMutation;
}

const storeName = 'drafts';

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const opening = indexedDB.open('erd-server-recovery', 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore(storeName, { keyPath: 'key' });
    store.createIndex('owner-document', ['owner', 'documentId']);
  };
  const database = await result(opening);
  try {
    const transaction = database.transaction(storeName, mode);
    const completion = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Recovery transaction aborted.'));
    });
    const [value] = await Promise.all([result(run(transaction.objectStore(storeName))), completion]);
    return value;
  } finally {
    database.close();
  }
}

export async function serverDrafts(owner: string, documentId: string): Promise<ServerDraft[]> {
  const rows = await useStore('readonly', store => store.index('owner-document').getAll([owner, documentId]));
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function storeServerDraft(key: string, owner: string, baseRevision: number, document: ErdDocument, pending?: Mutation) {
  const draft: ServerDraft = {
    key, owner, documentId: document.id, baseRevision, updatedAt: new Date().toISOString(),
    serialized: serializeDocument(document),
    pending: pending && { mutationId: pending.mutationId, baseRevision: pending.baseRevision, serialized: serializeDocument(pending.document) },
  };
  return useStore('readwrite', store => store.put(draft));
}

export function removeServerDraft(key: string, expected?: ServerDraft) {
  if (!expected) return useStore('readwrite', store => store.delete(key));
  return useStore('readwrite', store => {
    const reading: IDBRequest<ServerDraft | undefined> = store.get(key);
    reading.addEventListener('success', () => {
      const current = reading.result;
      if (current?.updatedAt === expected.updatedAt && current.serialized === expected.serialized &&
          current.baseRevision === expected.baseRevision && current.pending?.mutationId === expected.pending?.mutationId) store.delete(key);
    });
    return reading;
  });
}

export function openServerDraft(draft: ServerDraft, owner: string, documentId: string) {
  if (draft.owner !== owner || draft.documentId !== documentId || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 1) {
    throw new Error('Invalid server recovery metadata.');
  }
  const document = deserializeDocument(draft.serialized);
  if (document.id !== documentId) throw new Error('Recovery document ID mismatch.');
  let pending: Mutation | undefined;
  if (draft.pending && draft.pending.baseRevision === draft.baseRevision) {
    const snapshot = deserializeDocument(draft.pending.serialized);
    if (snapshot.id !== documentId) throw new Error('Recovery snapshot ID mismatch.');
    pending = { baseRevision: draft.pending.baseRevision, mutationId: draft.pending.mutationId, document: snapshot };
  }
  return { document, pending };
}
