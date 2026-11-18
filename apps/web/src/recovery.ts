import { deserializeDocument, serializeDocument } from '@erd/model';
import type { ErdDocument } from '@erd/model';

const owner = 'anonymous:local';
const storeName = 'drafts';
export const draftKey = (id: string) => JSON.stringify([owner, id]);

export interface Draft {
  key: string;
  owner: string;
  documentId: string;
  updatedAt: string;
  formatVersion: number;
  baseRevision: null;
  generation: number;
  serialized: string;
  tabId?: string;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

async function open() {
  const opening = indexedDB.open('erd-local-recovery', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(storeName, { keyPath: 'key' });
  return request(opening);
}

function finished(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export async function readDrafts(): Promise<Draft[]> {
  const database = await open();
  try {
    const all: Draft[] = await request(database.transaction(storeName).objectStore(storeName).getAll());
    return all.filter(item => item && item.owner === owner).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  } finally {
    database.close();
  }
}

export function restoreDraft(draft: Draft) {
  const document = deserializeDocument(draft.serialized);
  if (draft.owner !== owner || typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt)) ||
      document.id !== draft.documentId || document.formatVersion !== draft.formatVersion ||
      !Number.isSafeInteger(draft.generation) || draft.generation < 1 || draft.baseRevision !== null ||
      draft.key !== (draft.tabId ? JSON.stringify([owner, document.id, draft.tabId]) : draftKey(document.id))) {
    throw new Error('Invalid recovery envelope.');
  }
  return document;
}

export async function writeDraft(document: ErdDocument, expected: number, tabId: string) {
  const serialized = serializeDocument(document);
  const key = draftKey(document.id);
  const database = await open();
  try {
    const transaction = database.transaction(storeName, 'readwrite');
    const complete = finished(transaction);
    let result: { draft: Draft; conflict: boolean } | undefined;
    const store = transaction.objectStore(storeName);
    const reading = store.get(key);
    reading.onsuccess = () => {
      const current = reading.result as Draft | undefined;
      let conflict = (current?.generation ?? 0) !== expected;
      if (current && !conflict) {
        try {
          restoreDraft(current);
        } catch {
          conflict = true;
        }
      }
      const destination = conflict ? JSON.stringify([owner, document.id, tabId]) : key;
      const save = (generation: number) => {
        const draft: Draft = {
          key: destination, owner, documentId: document.id, updatedAt: new Date().toISOString(),
          formatVersion: document.formatVersion, baseRevision: null, generation, serialized,
          tabId: conflict ? tabId : undefined,
        };
        store.put(draft);
        result = { draft, conflict };
      };
      if (conflict) {
        const branch = store.get(destination);
        branch.onsuccess = () => save((branch.result?.generation ?? 0) + 1);
      } else save(expected + 1);
    };
    await complete;
    if (!result) throw new Error('IndexedDB did not save the draft.');
    return result;
  } finally {
    database.close();
  }
}
