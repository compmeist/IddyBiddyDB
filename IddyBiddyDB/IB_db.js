// IB_db.js — opening a database, migrations, transactions, and the Database
// facade you will use 90% of the time.
//
// IndexedDB 3 (https://www.w3.org/TR/IndexedDB/) in one paragraph:
// a database holds named *object stores* (think: tables). Each store holds
// records under a *key* — either taken from a property of the record itself
// (keyPath, e.g. 'id') or supplied separately. *Indexes* are sorted copies of
// one property that make lookups fast. Everything happens inside a
// *transaction*; if a transaction aborts, all of its writes roll back.
// IDB 3 adds: indexedDB.databases(), transaction durability hints, and
// getAll/getAllKeys options + getAllRecords() (see IB_table.js). We feature-
// detect all of them, so this file also runs on IDB 2 engines.
//
// Junior path:
//   const db = await ibOpenDatabase({ name: 'shop', stores: { orders: 'id' } });
//   await db.table('orders').put({ id: 1, total: 42 });
//
// Store shorthand in `stores`:  'id'  |  { keyPath:'id', autoIncrement:true,
// indexes: { byStatus: 'status' } }  |  legacy array form (see IB_schemas.js).

import { ibIDB3Error, ibRequestToPromise, ibTxDone, ibUnwrapDB } from './IB_internal.js';
import { ibChangeBus, ibBroadcastChange, ibListenRemoteChanges } from './IB_events.js';
import { ibTable } from './IB_table.js';

export { ibTxDone, ibRequestToPromise as ibReqToPromise };

/** Normalize every accepted store description into one internal shape. */
export function ibNormalizeStores(stores) {
  if (!stores) return [];
  if (Array.isArray(stores)) {
    // Legacy/generic descriptor: [{ name, keyPath, autoIncrement, indexes: [{name, keyPath, unique, multiEntry}] }]
    return stores.map((s) => ({
      name: s.name,
      keyPath: s.keyPath ?? null,
      autoIncrement: Boolean(s.autoIncrement),
      indexes: (s.indexes ?? []).map((i) => ({
        name: i.name, keyPath: i.keyPath,
        unique: Boolean(i.unique), multiEntry: Boolean(i.multiEntry),
      })),
    }));
  }
  // Object form: { orders: 'id', people: { keyPath:'id', indexes:{ byName:'name' } } }
  return Object.entries(stores).map(([name, def]) => {
    if (typeof def === 'string' || def == null) {
      return { name, keyPath: def ?? null, autoIncrement: false, indexes: [] };
    }
    const indexes = Array.isArray(def.indexes)
      ? def.indexes.map((i) => ({ name: i.name, keyPath: i.keyPath, unique: Boolean(i.unique), multiEntry: Boolean(i.multiEntry) }))
      : Object.entries(def.indexes ?? {}).map(([idxName, kp]) =>
          typeof kp === 'string'
            ? { name: idxName, keyPath: kp, unique: false, multiEntry: false }
            : { name: idxName, keyPath: kp.keyPath, unique: Boolean(kp.unique), multiEntry: Boolean(kp.multiEntry) });
    return { name, keyPath: def.keyPath ?? null, autoIncrement: Boolean(def.autoIncrement), indexes };
  });
}

function applyStores(db, tx, stores) {
  for (const s of stores) {
    const store = tx.objectStoreNames.contains(s.name)
      ? tx.objectStore(s.name)
      : db.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
    for (const idx of s.indexes) {
      if (!store.indexNames.contains(idx.name)) {
        store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
      }
    }
  }
}

/**
 * Open (or create/upgrade) a database. Returns a Database wrapper.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} [opts.version=1]
 * @param {object|Array} [opts.stores]  - shorthand object or descriptor array
 * @param {Array} [opts.schemas]        - legacy alias of `stores` (array form)
 * @param {(db:IDBDatabase, tx:IDBTransaction, oldVersion:number, newVersion:number)=>void} [opts.upgrade]
 *        Extra migration code, run inside the versionchange transaction
 *        after `stores` have been applied. Bump `version` to run it.
 * @param {(info:{oldVersion:number,newVersion:number|null})=>void} [opts.onBlocked]
 * @param {boolean} [opts.broadcast=true] - announce writes to other tabs and
 *        hear theirs (installs the cross-tab remote-change listener; set
 *        false to opt this connection out of cross-tab notification entirely)
 */
export async function ibOpenDatabase({ name, version = 1, stores, schemas, upgrade, onBlocked, broadcast = true } = {}) {
  if (!name) throw new ibIDB3Error('ibOpenDatabase: `name` is required', { code: 'NO_NAME' });
  const storeDefs = ibNormalizeStores(stores ?? schemas ?? []);
  const raw = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => {
      try {
        applyStores(event.target.result, event.target.transaction, storeDefs);
        upgrade?.(event.target.result, event.target.transaction, event.oldVersion, event.newVersion);
      } catch (err) { reject(err); }
    };
    req.onblocked = () => {
      onBlocked?.({ oldVersion: req.result?.version });
      reject(new ibIDB3Error('IndexedDB open blocked: another tab holds an older version. Close other tabs and retry.', { code: 'BLOCKED' }));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new ibDatabase(raw, { storeDefs, broadcast });
}

/** List databases for this origin (IDB 3 `indexedDB.databases()`), or [] when unsupported. */
export async function ibListDatabases() {
  return typeof indexedDB?.databases === 'function' ? indexedDB.databases() : [];
}

/** Delete a whole database. Resolves when gone; rejects if blocked by open tabs. */
export function ibDeleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new ibIDB3Error(`ibDeleteDatabase("${name}") blocked by an open tab`, { code: 'BLOCKED' }));
  });
}

let ibInstanceCounter = 0;

export class ibDatabase {
  #tables = new Map();

  constructor(raw, { storeDefs = [], broadcast = true } = {}) {
    /** The raw IDBDatabase. Escape hatch for anything this shim does not cover. */
    this.raw = raw;
    this.name = raw.name;
    this.version = raw.version;
    /** Change bus: db.on('change', fn). Also an EventTarget for DOM-style listeners. */
    this.events = new ibChangeBus();
    this.storeDefs = new Map(storeDefs.map((s) => [s.name, s]));
    this._broadcast = broadcast;
    // Unique sender id for cross-tab messages: lets our own remote-change
    // listener ignore echoes of our own broadcasts (see IB_events.js).
    this._sourceId = globalThis.crypto?.randomUUID?.()
      ?? `ib-${++ibInstanceCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Cross-tab: ordinary initialization installs the remote-change
    // listener, so two plain tabs refresh each other's live queries with
    // no sync worker involved. (Previously only IB_worker-client.js
    // installed it, so cross-tab refresh silently required the worker.)
    // `_emitRemoteChange` only re-emits locally, so this cannot loop.
    this._stopRemoteListener = this._broadcast
      ? ibListenRemoteChanges(this.name, (change) => this._emitRemoteChange(change), { sourceId: this._sourceId })
      : () => {};
    // If another tab wants to upgrade, close politely so it is not blocked.
    raw.onversionchange = () => {
      this._stopRemoteListener();
      raw.close();
      this.events.emit('versionchange', { name: this.name });
    };
    raw.onclose = () => this.events.emit('close', { name: this.name });
  }

  /** All store (table) names currently in the database. */
  get storeNames() { return [...this.raw.objectStoreNames]; }

  /** Schema info for one store: { name, keyPath, autoIncrement, indexes: Map }. */
  schemaOf(storeName) {
    const known = this.storeDefs.get(storeName);
    if (known) return { ...known, indexes: new Map(known.indexes.map((i) => [i.name, i])) };
    if (!this.raw.objectStoreNames.contains(storeName)) return null;
    const tx = this.raw.transaction(storeName, 'readonly');
    const os = tx.objectStore(storeName);
    const indexes = new Map([...os.indexNames].map((n) => {
      const ix = os.index(n);
      return [n, { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }];
    }));
    return { name: storeName, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes };
  }

  /** Find the index (if any) whose keyPath is exactly `field` — used by the query planner. */
  indexForField(storeName, field) {
    const schema = this.schemaOf(storeName);
    if (!schema) return null;
    for (const idx of schema.indexes.values()) if (idx.keyPath === field) return idx;
    return null;
  }

  /** Get the friendly handle for one store. Cached: db.table('x') === db.table('x'). */
  table(name) {
    if (!this.#tables.has(name)) this.#tables.set(name, new ibTable(this, name));
    return this.#tables.get(name);
  }

  /** Start a fluent query: db.from('orders').where(...).toArray() (see IB_pipeline.js). */
  from(storeName) {
    // Imported lazily to keep module graph simple (pipeline -> table -> db).
    return this.table(storeName).query();
  }

  /**
   * Run `fn` inside ONE transaction spanning several stores — all writes
   * commit together or roll back together.
   *   await db.tx(['orders','stock'], 'readwrite', async (tx) => {
   *     await tx.table('orders').put(order);       // use these handles,
   *     await tx.table('stock').update(id, fn);    // not db.table(...)
   *   }, { durability: 'strict' });
   * WARNING (classic IDB trap): a transaction auto-commits as soon as you
   * await something that is not an IDB request (fetch, setTimeout...).
   * Do that work BEFORE opening the transaction.
   * durability (IDB 3): 'strict' | 'relaxed' | 'default'.
   *
   * Change notification: writes through the tx-bound handles are buffered
   * (see IB_table._changed) and published here only after the transaction
   * commits — one notification per touched store (a single write keeps its
   * exact { type, key, record } shape; several writes collapse to
   * { type: 'bulk', keys, changes }). An aborted transaction publishes
   * nothing, so liveQuery() subscribers never see rolled-back data.
   */
  async tx(storeNames, mode, fn, { durability } = {}) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const options = durability ? { durability } : undefined;
    let idbTx;
    try { idbTx = this.raw.transaction(names, mode, options); }
    catch { idbTx = this.raw.transaction(names, mode); } // older engines reject the options arg
    const handles = new Map(names.map((n) => [n, new ibTable(this, n, idbTx)]));
    const api = {
      raw: idbTx,
      table: (n) => {
        if (!handles.has(n)) handles.set(n, new ibTable(this, n, idbTx));
        return handles.get(n);
      },
    };
    const result = await fn(api);
    await ibTxDone(idbTx);
    // Committed: flush the buffered changes, grouped per store.
    const byStore = new Map();
    for (const handle of handles.values()) {
      for (const change of handle._drainChanges()) {
        if (!byStore.has(change.store)) byStore.set(change.store, []);
        byStore.get(change.store).push(change);
      }
    }
    for (const [store, changes] of byStore) {
      if (changes.length === 1) {
        this._emitChange(changes[0]);
      } else {
        const keys = changes.flatMap((c) => [
          ...(c.key !== undefined ? [c.key] : []),
          ...(Array.isArray(c.keys) ? c.keys : []),
        ]);
        this._emitChange({ store, type: 'bulk', keys, changes });
      }
    }
    return result;
  }

  /** Subscribe to changes: db.on('change', ({store,type,key}) => ...). Returns unsubscribe. */
  on(type, listener, options) { return this.events.on(type, listener, options); }

  /** Internal: record + announce one change (also cross-tab when enabled). */
  _emitChange(change) {
    this.events.emitChange(change);
    if (this._broadcast) ibBroadcastChange(this.name, change, this._sourceId);
  }

  /**
   * Live query: re-runs `run` whenever one of `stores` changes (this tab,
   * another tab, or the sync worker). Returns { current, subscribe, dispose }.
   *   const live = db.liveQuery(() => db.from('orders').where({status:'open'}).toArray(), ['orders']);
   *   const stop = live.subscribe((rows) => grid.data = rows);
   */
  liveQuery(run, stores = []) {
    let current;
    let disposed = false;
    const listeners = new Set();
    const refresh = async () => {
      if (disposed) return;
      current = await run();
      for (const fn of listeners) fn(current);
    };
    const wanted = new Set(stores);
    const offChange = this.events.on('change', (e) => {
      if (!wanted.size || wanted.has(e.detail?.store)) void refresh();
    });
    const offRemote = this.events.on('remote-change', (e) => {
      if (!wanted.size || wanted.has(e.detail?.store)) void refresh();
    });
    void refresh();
    return {
      get current() { return current; },
      refresh,
      subscribe(fn) { listeners.add(fn); if (current !== undefined) fn(current); return () => listeners.delete(fn); },
      dispose() { disposed = true; offChange(); offRemote(); listeners.clear(); },
    };
  }

  /** Adopt a change announced by another tab/worker as a local event. */
  _emitRemoteChange(change) { this.events.emit('remote-change', change); }

  close() {
    this._stopRemoteListener?.();
    this.raw.close();
  }
}

/* ------- Backwards-compatible free functions (original IB_db.js API) ------- */

/** Bulk-read a store (or one of its indexes) into an array. Prefer table().getAll(). */
export async function ibGetAllRecords(db, storeName, { index, range, signal } = {}) {
  const raw = ibUnwrapDB(db);
  const source = index
    ? raw.transaction(storeName, 'readonly').objectStore(storeName).index(index)
    : raw.transaction(storeName, 'readonly').objectStore(storeName);
  return ibTableReadAll(source, { range, signal });
}

export async function ibTableReadAll(source, { range, count, direction = 'next', signal } = {}) {
  // IDB 3: getAll({ query, count, direction }). Fall back to getAll(range, count).
  try {
    return await ibRequestToPromise(source.getAll({ query: range ?? null, count, direction }), signal);
  } catch {
    return ibRequestToPromise(range !== undefined ? source.getAll(range, count) : source.getAll(count), signal);
  }
}

/** Bulk-write records in one transaction. Prefer table().putAll(). */
export async function ibPutAllRecords(db, storeName, records) {
  const raw = ibUnwrapDB(db);
  const tx = raw.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const r of records) store.put(r);
  await ibTxDone(tx);
  if (db instanceof ibDatabase) db._emitChange({ store: storeName, type: 'bulk', keys: [] });
}
