// IndexedDB-backed store for the user's recent videos, keyed by head-hash.
// The point is to re-hydrate the Project import flow: if you import a
// .subifi.json you exported last week, we can look up the video by hash
// and re-attach it automatically — no "drag your source file back in"
// prompt for the common case of working on the same machine.
//
// Storage budget: CACHE_MAX_BYTES (2 GB). When a put would push us over,
// we evict the least-recently-accessed entries until we're back under
// budget. The eviction pass is best-effort; if a single blob is larger
// than the budget we store it anyway and let the next put clean up.
//
// All database interactions go through `withStore`, a small helper that
// wraps the `openDatabase → transaction → objectStore` boilerplate into
// a promise. The rest of the file reads like plain async code.

export const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const DB_NAME = 'subifi-video-cache';
const DB_VERSION = 1;
const STORE = 'videos';

export type CachedVideoMeta = {
  hash: string;
  name: string;
  size: number;
  type: string;
  addedAt: number;       // epoch ms
  lastAccessedAt: number;// epoch ms — drives LRU eviction
};

export type CachedVideoRecord = CachedVideoMeta & {
  blob: Blob;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'hash' });
        store.createIndex('lastAccessedAt', 'lastAccessedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result: T | undefined;
      Promise.resolve(fn(store)).then(
        (v) => {
          result = v;
        },
        (err) => reject(err),
      );
      tx.oncomplete = () => resolve(result as T);
      tx.onerror = () => reject(tx.error ?? new Error('IDB tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
    });
  } finally {
    db.close();
  }
}

// Wrap an IDBRequest in a promise. Re-used across list / get / put / delete.
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

export async function getVideo(hash: string): Promise<CachedVideoRecord | null> {
  return withStore('readwrite', async (store) => {
    const rec = (await reqToPromise(store.get(hash))) as CachedVideoRecord | undefined;
    if (!rec) return null;
    // Update lastAccessedAt on read so the LRU stays accurate.
    const touched: CachedVideoRecord = { ...rec, lastAccessedAt: Date.now() };
    await reqToPromise(store.put(touched));
    return touched;
  });
}

export async function listVideos(): Promise<CachedVideoMeta[]> {
  return withStore('readonly', async (store) => {
    const all = (await reqToPromise(store.getAll())) as CachedVideoRecord[];
    return all.map(({ blob: _blob, ...meta }) => meta);
  });
}

export async function deleteVideo(hash: string): Promise<void> {
  await withStore('readwrite', (store) => reqToPromise(store.delete(hash)));
}

export async function putVideo(
  hash: string,
  file: File | Blob,
  name: string,
): Promise<void> {
  const now = Date.now();
  const record: CachedVideoRecord = {
    hash,
    name,
    size: file.size,
    type: file.type || 'video/mp4',
    addedAt: now,
    lastAccessedAt: now,
    blob: file instanceof Blob ? file : new Blob([file]),
  };
  await withStore('readwrite', async (store) => {
    await reqToPromise(store.put(record));
  });
  // Eviction runs in a separate transaction so a failure there doesn't
  // roll back the put we just committed.
  await evictIfNeeded();
}

// Walk entries in ascending lastAccessedAt order, deleting until the total
// size is under CACHE_MAX_BYTES. A no-op when we're already under budget.
async function evictIfNeeded(): Promise<void> {
  await withStore('readwrite', async (store) => {
    const all = (await reqToPromise(store.getAll())) as CachedVideoRecord[];
    const total = all.reduce((sum, r) => sum + r.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    const sorted = [...all].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let remaining = total;
    for (const rec of sorted) {
      if (remaining <= CACHE_MAX_BYTES) break;
      await reqToPromise(store.delete(rec.hash));
      remaining -= rec.size;
    }
  });
}
