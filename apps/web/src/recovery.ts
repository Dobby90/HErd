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
  branchId?: string;
}

export type DraftEntry = Draft | { key: string; invalid: true };

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validMetadata(draft: unknown): draft is Draft {
  if (!record(draft) || draft.owner !== owner || typeof draft.documentId !== 'string' || !draft.documentId ||
      typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt)) ||
      typeof draft.formatVersion !== 'number' || !Number.isSafeInteger(draft.formatVersion) || draft.formatVersion < 1 ||
      typeof draft.generation !== 'number' || !Number.isSafeInteger(draft.generation) || draft.generation < 1 ||
      draft.baseRevision !== null || typeof draft.serialized !== 'string') return false;
  if (draft.tabId === undefined) return draft.branchId === undefined && draft.key === draftKey(draft.documentId);
  if (typeof draft.tabId !== 'string' || !draft.tabId) return false;
  const keyParts = [owner, draft.documentId, draft.tabId];
  if (draft.branchId !== undefined) {
    if (typeof draft.branchId !== 'string' || !draft.branchId) return false;
    keyParts.push(draft.branchId);
  }
  return draft.key === JSON.stringify(keyParts);
}

export async function readDrafts(): Promise<DraftEntry[]> {
  const database = await open();
  try {
    const all: unknown[] = await request(database.transaction(storeName).objectStore(storeName).getAll());
    const valid: Draft[] = [];
    const invalid: DraftEntry[] = [];
    for (const item of all) {
      if (validMetadata(item)) valid.push(item);
      else if (record(item) && item.owner === owner && typeof item.key === 'string') invalid.push({ key: item.key, invalid: true });
    }
    return [...valid.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), ...invalid];
  } finally {
    database.close();
  }
}

export async function readDraft(key: string): Promise<unknown> {
  const database = await open();
  try {
    return await request(database.transaction(storeName).objectStore(storeName).get(key));
  } finally {
    database.close();
  }
}

export function restoreDraft(draft: unknown) {
  if (!validMetadata(draft)) throw new Error('Invalid recovery envelope.');
  const document = deserializeDocument(draft.serialized);
  if (document.id !== draft.documentId || document.formatVersion !== draft.formatVersion) {
    throw new Error('Invalid recovery envelope.');
  }
  return { document, draft };
}

export async function writeDraft(document: ErdDocument, key: string, expected: number, tabId: string) {
  const serialized = serializeDocument(document);
  const branchId = crypto.randomUUID();
  const database = await open();
  try {
    const transaction = database.transaction(storeName, 'readwrite');
    const complete = finished(transaction);
    let result: { draft: Draft; conflict: boolean } | undefined;
    const store = transaction.objectStore(storeName);
    const reading = store.get(key);
    reading.onsuccess = () => {
      let current: Draft | undefined;
      let conflict = expected !== 0;
      if (reading.result !== undefined) {
        try {
          current = restoreDraft(reading.result).draft;
          conflict = current.documentId !== document.id || current.generation !== expected;
        } catch {
          conflict = true;
        }
      }
      const draft: Draft = {
        key: conflict ? JSON.stringify([owner, document.id, tabId, branchId]) : key,
        owner, documentId: document.id, updatedAt: new Date().toISOString(),
        formatVersion: document.formatVersion, baseRevision: null, generation: conflict ? 1 : expected + 1, serialized,
        tabId: conflict ? tabId : current?.tabId,
        branchId: conflict ? branchId : current?.branchId,
      };
      if (conflict) store.add(draft);
      else store.put(draft);
      result = { draft, conflict };
    };
    await complete;
    if (!result) throw new Error('IndexedDB did not save the draft.');
    return result;
  } finally {
    database.close();
  }
}
