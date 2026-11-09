import type { ImageConfig, ImageReference } from './generation';

export interface GenerationRecord {
  id: string;
  createdAt: number;
  model: string;
  size: string;
  quality: ImageConfig['quality'];
  prompt: string;
  references: ImageReference[];
  image: Blob;
  threeView?: boolean;
}

const databaseName = 'opc-generation-history';
const storeName = 'results';

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('historyBlocked'));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error);
      transaction.onerror = () => reject(transaction.error || request.error);
    });
  } finally {
    db.close();
  }
}

export async function listGenerationHistory(): Promise<GenerationRecord[]> {
  const records = await transact<GenerationRecord[]>('readonly', (store) => store.getAll());
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveGenerationRecord(record: GenerationRecord): Promise<void> {
  await transact('readwrite', (store) => store.put(record));
  const records = await listGenerationHistory();
  for (const old of records.slice(20)) await deleteGenerationRecord(old.id);
}

export async function deleteGenerationRecord(id: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(id));
}

export async function readResultBlob(
  source: string,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<Blob> {
  const url = new URL(source, window.location.href);
  if (!['https:', 'blob:', 'data:'].includes(url.protocol)) throw Error('invalidResult');
  const response = await fetch(url.href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw Error('invalidResult');
  let blob: Blob;
  if (maxBytes !== undefined) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      Number(response.headers.get('content-length') || 0) > maxBytes ||
      !response.body
    )
      throw Error('invalidResult');
    const reader = response.body.getReader();
    const parts: BlobPart[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw Error('invalidResult');
        parts.push(new Uint8Array(value).buffer);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    blob = new Blob(parts, { type: response.headers.get('content-type')?.split(';')[0] || '' });
  } else blob = await response.blob();
  if (!blob.size || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
    throw Error('invalidResult');
  return blob;
}
