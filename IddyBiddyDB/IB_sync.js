// IB_sync.js — the caching-layer sync: IndexedDB sits between your UI and the
// server API. Reads hit the local store instantly; writes land locally first,
// queue in an `outbox` store, and flush to the server when you say so.
//
// TAILOR IT TO YOUR BACKEND — the engine only knows three functions:
//   pull(sinceSeq)            -> { changes: [{ store, record }], seq }
//   push(batch)               -> post mutations; throw to keep them queued
//   resolve(local, remote)    -> winning record (or a strategy name)
// Bring your own functions (any REST/GraphQL/RPC client), or build them from
// a REST description with ibFetchSyncAdapter() below. No SQL, no fixed URLs.
//
//   const sync = ibCreateSyncEngine(db, { pull: myPull, push: myPush });
//   await sync.pull();                       // server -> local (all stores)
//   await db.table('orders').put(order);     // local write (instant UI)
//   await sync.syncOne('orders', order.id);  // push JUST this one record
//   await sync.push();                       // flush the whole outbox
//   sync.startAuto();                        // push on 'online' + debounce
//
// Conventions: tombstones are records with _deleted: true; the last-seen
// server sequence lives in the `meta` store under 'syncSeq'; conflicts
// default to last-write-wins on `updatedAt`.

import { ibRequestToPromise, ibTxDone, ibUnwrapDB } from './IB_internal.js';
import { ibChangeBus } from './IB_events.js';

/* ---------------- meta + outbox primitives ---------------- */

async function rawTx(db, storeName, mode, fn) {
  const raw = ibUnwrapDB(db);
  const tx = raw.transaction(storeName, mode);
  const result = await fn(tx.objectStore(storeName));
  await ibTxDone(tx);
  return result;
}

export async function ibGetMeta(db, key) {
  try {
    const raw = ibUnwrapDB(db);
    const tx = raw.transaction('meta', 'readonly');
    return (await ibRequestToPromise(tx.objectStore('meta').get(key)))?.value ?? null;
  } catch { return null; }
}

export async function ibSetMeta(db, key, value) {
  await rawTx(db, 'meta', 'readwrite', (os) => ibRequestToPromise(os.put({ key, value })));
}

/** Queue one local mutation for the next push. mutation: { store, op, record, key? } */
export async function ibEnqueueMutation(db, mutation) {
  const entry = { ...mutation, updatedAt: mutation.updatedAt ?? Date.now(), queuedAt: Date.now() };
  await rawTx(db, 'outbox', 'readwrite', (os) => ibRequestToPromise(os.add(entry)));
  return entry;
}

export async function ibPendingMutations(db) {
  try {
    const raw = ibUnwrapDB(db);
    const tx = raw.transaction('outbox', 'readonly');
    const rows = await ibRequestToPromise(tx.objectStore('outbox').getAll());
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  } catch { return []; }
}

async function clearOutboxEntries(db, entries) {
  if (!entries.length) return;
  await rawTx(db, 'outbox', 'readwrite', async (os) => {
    for (const e of entries) await ibRequestToPromise(os.delete(e.seq));
  });
}

/** Deliver every queued mutation; on throw, entries stay queued for retry. */
export async function ibPushOutbox(db, deliver) {
  const pending = await ibPendingMutations(db);
  if (!pending.length) return { pushed: 0 };
  await deliver(pending);
  await clearOutboxEntries(db, pending);
  return { pushed: pending.length };
}

/* ---------------- conflicts ---------------- */

/**
 * Pick the winner between local and remote copies.
 * strategy: 'last-write-wins' (updatedAt) | 'server-wins' | 'client-wins'
 *           | 'merge' (remote wins per-field only where local is older)
 *           | (local, remote) => winner
 */
export function ibResolveConflict(local, remote, strategy = 'last-write-wins') {
  if (typeof strategy === 'function') return strategy(local, remote);
  if (strategy === 'server-wins') return remote;
  if (strategy === 'client-wins') return local;
  if (strategy === 'merge') {
    if (!local) return remote;
    if (!remote) return local;
    return (remote.updatedAt ?? 0) >= (local.updatedAt ?? 0) ? { ...local, ...remote } : { ...remote, ...local };
  }
  return (remote?.updatedAt ?? 0) >= (local?.updatedAt ?? 0) ? remote : local;
}

/* ---------------- applying remote changes ---------------- */

async function applyChanges(db, changes, resolve) {
  const byStore = new Map();
  for (const c of changes ?? []) {
    if (!byStore.has(c.store)) byStore.set(c.store, []);
    byStore.get(c.store).push(c.record);
  }
  let applied = 0;
  for (const [store, records] of byStore) {
    const keyPath = db.schemaOf?.(store)?.keyPath ?? 'id';
    await rawTx(db, store, 'readwrite', async (os) => {
      for (const record of records) {
        const key = record?.[keyPath] ?? record?.id ?? record?.key;
        if (record?._deleted) { await ibRequestToPromise(os.delete(key)); applied++; continue; }
        const local = key !== undefined ? await ibRequestToPromise(os.get(key)) : undefined;
        const winner = local === undefined ? record : ibResolveConflict(local, record, resolve);
        await ibRequestToPromise(os.put(winner));
        applied++;
      }
    });
    db._emitChange?.({ store, type: 'bulk', keys: records.map((r) => r?.[keyPath]) });
  }
  return applied;
}

/** Legacy one-shot pull: ibPullFromServer(db, pullSinceFn). Prefer ibSyncEngine. */
export async function ibPullFromServer(db, pullSince, { resolve = 'last-write-wins' } = {}) {
  const since = (await ibGetMeta(db, 'syncSeq')) ?? 0;
  const { changes, seq } = await pullSince(since);
  const applied = await applyChanges(db, changes, resolve);
  await ibSetMeta(db, 'syncSeq', seq);
  return { applied, seq };
}

/* ---------------- REST adapter: describe your API, get pull/push ---------------- */

/**
 * Build pull/push functions from a plain REST description — headers may be a
 * function so tokens stay fresh. Expected server shapes (adapt with parse*):
 *   pull: GET {baseUrl}{pullPath}?since={seq}  -> { changes, seq }
 *   push: POST {baseUrl}{pushPath}  body: JSON batch -> any 2xx
 */
export function ibFetchSyncAdapter({
  baseUrl = '', pullPath = '/sync/pull', pushPath = '/sync/push',
  headers, fetchFn = (...a) => fetch(...a), parsePull, parsePush,
} = {}) {
  const head = async () => ({ 'Content-Type': 'application/json', ...(typeof headers === 'function' ? await headers() : headers ?? {}) });
  return {
    async pull(since) {
      const url = `${baseUrl}${pullPath}${pullPath.includes('?') ? '&' : '?'}since=${encodeURIComponent(since ?? 0)}`;
      const res = await fetchFn(url, { headers: await head() });
      if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
      const json = await res.json();
      return parsePull ? parsePull(json) : json; // { changes: [{store, record}], seq }
    },
    async push(batch) {
      const res = await fetchFn(`${baseUrl}${pushPath}`, { method: 'POST', headers: await head(), body: JSON.stringify(batch) });
      if (!res.ok) throw new Error(`sync push failed: HTTP ${res.status}`);
      return parsePush ? parsePush(await res.json().catch(() => null)) : undefined;
    },
    async pushOne(entry) { return this.push([entry]); },
  };
}

/* ---------------- the engine ---------------- */

export class ibSyncEngine {
  /**
   * @param {object} db Database wrapper from ibOpenDatabase()
   * @param {object} opts { pull, push, pushOne?, pullOne?, resolve?, retries?, backoffMs? }
   *        pull/push may come from ibFetchSyncAdapter() or be hand-written.
   */
  constructor(db, { pull, push, pushOne, pullOne, resolve = 'last-write-wins', retries = 2, backoffMs = 500 } = {}) {
    this.db = db;
    this._pullFn = pull; this._pushFn = push; this._pushOneFn = pushOne; this._pullOneFn = pullOne;
    this.resolve = resolve;
    this.retries = retries; this.backoffMs = backoffMs;
    this.events = new ibChangeBus();
    this._applyingRemote = false;
    this._auto = null;
  }

  on(type, fn) { return this.events.on(type, fn); }

  /** Server -> local. Returns { applied, seq }. Emits 'pulled'. */
  async pull() {
    if (!this._pullFn) throw new Error('ibSyncEngine: no pull function configured');
    const since = (await ibGetMeta(this.db, 'syncSeq')) ?? 0;
    const { changes, seq } = await this._pullFn(since, { db: this.db });
    this._applyingRemote = true;
    try { var applied = await applyChanges(this.db, changes, this.resolve); }
    finally { this._applyingRemote = false; }
    await ibSetMeta(this.db, 'syncSeq', seq);
    this.events.emit('pulled', { applied, seq });
    return { applied, seq };
  }

  /** Local outbox -> server, with retry + backoff. Emits 'pushed'. */
  async push() {
    if (!this._pushFn) throw new Error('ibSyncEngine: no push function configured');
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await ibPushOutbox(this.db, (batch) => this._pushFn(batch, { db: this.db }));
        this.events.emit('pushed', result);
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** attempt));
      }
    }
    this.events.emit('push-failed', { error: lastError });
    throw lastError;
  }

  /** Pull then push. Returns { pulled, pushed }. */
  async sync() {
    const pulled = await this.pull();
    const pushed = await this.push();
    const result = { pulled, pushed };
    this.events.emit('synced', result);
    return result;
  }

  /**
   * Push JUST ONE record right now (the granular path — call it from a save
   * button, a grid row edit, any event). Reads the current local record and
   * delivers a single-entry batch; also drops any queued entry for that key.
   */
  async syncOne(store, key) {
    const table = this.db.table(store);
    const record = await table.get(key);
    const entry = { store, op: record === undefined ? 'delete' : 'put', key, record, updatedAt: Date.now() };
    if (this._pushOneFn) await this._pushOneFn(entry, { db: this.db });
    else if (this._pushFn) await this._pushFn([entry], { db: this.db });
    else throw new Error('ibSyncEngine: no push/pushOne function configured');
    const queued = (await ibPendingMutations(this.db)).filter((e) => e.store === store && e.key === key);
    await clearOutboxEntries(this.db, queued);
    this.events.emit('synced-one', { store, key });
    return { synced: 1, store, key };
  }

  /** Pull JUST ONE record (needs a pullOne fn, or falls back to full pull). */
  async pullOne(store, key) {
    if (!this._pullOneFn) return this.pull();
    const record = await this._pullOneFn(store, key, { db: this.db });
    this._applyingRemote = true;
    try {
      if (record == null || record._deleted) await this.db.table(store).delete(key);
      else await this.db.table(store).put(record);
    } finally { this._applyingRemote = false; }
    this.events.emit('pulled-one', { store, key });
    return { pulled: 1, store, key };
  }

  /** Queue a mutation AND write it locally in one call (offline-first edit). */
  async mutate(store, op, record) {
    const table = this.db.table(store);
    const keyPath = table.keyPath ?? 'id';
    const key = record?.[keyPath] ?? record?.id;
    if (op === 'delete') await table.delete(key); else await table.put(record);
    await ibEnqueueMutation(this.db, { store, op, key, record });
    return { queued: true, store, key };
  }

  /**
   * Auto mode: watch local changes (optionally per-store), debounce, push.
   * Also pushes when the browser comes back online. stopAuto() to end.
   * Remote-applied changes never re-queue (no echo loops).
   */
  startAuto({ stores, debounceMs = 800 } = {}) {
    this.stopAuto();
    let timer;
    const wanted = stores ? new Set(stores) : null;
    const off = this.db.events.on('change', (e) => {
      if (this._applyingRemote) return;
      const change = e.detail;
      if (change?.store === 'outbox' || change?.store === 'meta') return;
      if (wanted && !wanted.has(change?.store)) return;
      // A committed multi-write transaction arrives as one 'bulk' change
      // carrying its per-write `changes`; queue each write, not one
      // record-less bulk entry. (A plain bulk without `changes`, e.g.
      // putAll, keeps the previous single-entry behaviour.)
      const writes = Array.isArray(change.changes) && change.changes.length ? change.changes : [change];
      for (const write of writes) {
        void ibEnqueueMutation(this.db, {
          store: write.store ?? change.store, op: write.type === 'delete' ? 'delete' : 'put',
          key: write.key, record: write.record,
        }).catch(() => {});
      }
      clearTimeout(timer);
      timer = setTimeout(() => { void this.push().catch(() => {}); }, debounceMs);
    });
    const onOnline = () => { void this.push().catch(() => {}); };
    globalThis.addEventListener?.('online', onOnline);
    this._auto = () => { off(); clearTimeout(timer); globalThis.removeEventListener?.('online', onOnline); };
    return this._auto;
  }

  stopAuto() { this._auto?.(); this._auto = null; }
}

export function ibCreateSyncEngine(db, opts) { return new ibSyncEngine(db, opts); }
