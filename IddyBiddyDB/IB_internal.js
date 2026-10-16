// IB_internal.js — tiny shared helpers for the IddyBiddyDB modules.
// Not part of the junior-facing API (IB_index.js does not re-export most of it),
// but every other module builds on these three ideas:
//   1. IDB speaks in requests + events  -> we speak in Promises.
//   2. A raw IDBDatabase and our Database wrapper must both be accepted.
//   3. AbortSignal should cancel a pending read the way fetch() does.

/** Error type thrown by this library, with a stable machine-readable `code`. */
export class ibIDB3Error extends Error {
  constructor(message, { code = 'IDB3_ERROR', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ibIDB3Error';
    this.code = code;
  }
}

export function ibAbortError(signal) {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

export function ibThrowIfAborted(signal) {
  if (signal?.aborted) throw ibAbortError(signal);
}

/** Accept either our Database wrapper or a raw IDBDatabase. */
export function ibUnwrapDB(db) {
  return db?.raw ?? db;
}

/** Turn one IDBRequest into a Promise. Rejects early if `signal` aborts. */
export function ibRequestToPromise(req, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(ibAbortError(signal));
    const onAbort = () => reject(ibAbortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    req.onsuccess = () => { done(); resolve(req.result); };
    req.onerror = () => { done(); reject(req.error); };
  });
}

/** Resolve when a transaction commits; reject if it errors or aborts. */
export function ibTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new ibIDB3Error('Transaction aborted', { code: 'TX_ABORTED' }));
  });
}

/**
 * Feature detection for IndexedDB 3 additions (W3C TR/IndexedDB, 13 Aug 2025).
 * Everything here degrades gracefully on older engines — check, never assume.
 */
export const ibFeatures = {
  get databases() { return typeof indexedDB?.databases === 'function'; },
  get getAllOptions() {
    // IDBGetAllOptions { query, count, direction } for getAll/getAllKeys (Chrome/Edge 141+).
    return typeof IDBObjectStore !== 'undefined'; // probed per-call instead; see IB_table.js
  },
};

/** True when `value` can be an IndexedDB key (number, string, Date, array of keys). */
export function ibIsValidKey(value) {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string' || value instanceof Date) return true;
  return Array.isArray(value) && value.every(ibIsValidKey);
}
