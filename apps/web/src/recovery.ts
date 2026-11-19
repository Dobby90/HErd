import { deserializeDocument } from '@erd/model';

const owner = 'anonymous:local';
const storeName = 'drafts';
const draftKey = (id: string) => JSON.stringify([owner, id]);

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

type DraftEntry = Draft | { invalid: true };

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

export async function countDrafts() {
  if (typeof indexedDB.databases === 'function' &&
      !(await indexedDB.databases()).some(database => database.name === 'erd-local-recovery')) return 0;
  const database = await open();
  try {
    return await request(database.transaction(storeName).objectStore(storeName).count());
  } finally {
    database.close();
  }
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
      else invalid.push({ invalid: true });
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
