// IB_table.js — the friendly handle for ONE object store ("table").
//
//   const orders = db.table('orders');
//   await orders.put({ id: 1, total: 42 });          // insert or overwrite
//   await orders.update(1, { total: 50 });           // patch ONE record
//   await orders.update(1, (o) => ({ ...o, total: o.total + 8 }));
//   const order = await orders.get(1);
//   await orders.delete(1);
//
// Input flexibility (developers think in arrays and Maps, not requests):
//   * putAll / addAll accept an Array, a Map, or any iterable of records.
//     For a Map with out-of-line keys, entries are used as [key, record].
//   * getAll can hand results back as an Array, a Map, or an async stream.
// Records may contain nested objects/arrays and Map/Set/Date/Blob values —
// IndexedDB stores them natively via structured clone. (Only JSON-ish codec
// stores need IB_codecs.js; see the `binary` note there.)

import { ibIDB3Error, ibAbortError, ibRequestToPromise, ibThrowIfAborted, ibTxDone } from './IB_internal.js';
import { ibWrapValue, ibUnwrapValue } from './IB_codecs.js';

const DONE = Symbol('done');

export class ibTable {
  /**
   * @param {import('./IB_db.js').ibDatabase} db
   * @param {string} name store name
   * @param {IDBTransaction} [boundTx] when set, all ops join this transaction
   *        (created by db.tx(...)); change events fire once for the batch.
   */
  constructor(db, name, boundTx = null) {
    this.db = db;
    this.name = name;
    this._tx = boundTx;
  }

  get schema() { return this.db.schemaOf(this.name); }
  get keyPath() { return this.schema?.keyPath ?? null; }

  _store(mode = 'readonly', durability) {
    if (this._tx) return this._tx.objectStore(this.name);
    const raw = this.db.raw;
    try { return raw.transaction(this.name, mode, durability ? { durability } : undefined).objectStore(this.name); }
    catch { return raw.transaction(this.name, mode).objectStore(this.name); }
  }

  _writeStore(durability) { return this._store('readwrite', durability); }

  async _inTx(mode, fn, { durability, silent = false } = {}) {
    if (this._tx) return fn(this._tx.objectStore(this.name));
    const raw = this.db.raw;
    let tx;
    try { tx = raw.transaction(this.name, mode, durability ? { durability } : undefined); }
    catch { tx = raw.transaction(this.name, mode); }
    const result = await fn(tx.objectStore(this.name));
    await ibTxDone(tx);
    return result;
  }

  _changed(change) { if (!this._tx) this.db._emitChange({ store: this.name, ...change }); }

  /* ---------------- single-record reads ---------------- */

  /** One record by key, or undefined. Options: { index, signal, binary, codec }. */
  async get(key, { index, signal, binary = false, codec } = {}) {
    const source = index ? this._store().index(index) : this._store();
    const value = await ibRequestToPromise(source.get(key), signal);
    return value === undefined ? undefined : ibUnwrapValue(value, { binary, codec });
  }

  /** Only the key of the first match (fast existence / lookup checks). */
  async getKey(key, { index, signal } = {}) {
    const source = index ? this._store().index(index) : this._store();
    return ibRequestToPromise(source.getKey(key), signal);
  }

  async has(key, opts) { return (await this.getKey(key, opts)) !== undefined; }
  async count({ index, range, signal } = {}) {
    const source = index ? this._store().index(index) : this._store();
    return ibRequestToPromise(range !== undefined ? source.count(range) : source.count(), signal);
  }
  async keys({ index, range, count, direction = 'next', signal } = {}) {
    const source = index ? this._store().index(index) : this._store();
    try { return await ibRequestToPromise(source.getAllKeys({ query: range ?? null, count, direction }), signal); }
    catch { return ibRequestToPromise(range !== undefined ? source.getAllKeys(range, count) : source.getAllKeys(count), signal); }
  }

  /* ---------------- bulk reads ---------------- */

  /**
   * All matching records as an array.
   * { index, range (IDBKeyRange), count, direction: 'next'|'prev', signal, binary, codec }
   * Uses IDB 3 getAll({query,count,direction}) when available.
   */
  async getAll({ index, range, count, direction = 'next', signal, binary = false, codec } = {}) {
    const source = index ? this._store().index(index) : this._store();
    let rows;
    try { rows = await ibRequestToPromise(source.getAll({ query: range ?? null, count, direction }), signal); }
    catch { rows = await ibRequestToPromise(range !== undefined ? source.getAll(range, count) : source.getAll(count), signal); }
    return binary ? rows.map((r) => ibUnwrapValue(r, { binary, codec })) : rows;
  }

  /** Same read as getAll(), but as Map<key, record> (keys are the primary keys). */
  async getAllAsMap(opts = {}) {
    const keys = await this.keys(opts);
    const rows = await this.getAll(opts);
    const map = new Map();
    // getAll and getAllKeys return in the same key order, so they zip cleanly.
    const fallback = this.keyPath;
    rows.forEach((row, i) => map.set(keys[i] ?? row?.[fallback] ?? i, row));
    return map;
  }

  /** Records WITH their keys: [{ key, primaryKey, value }] (IDB 3 getAllRecords, with fallback). */
  async getAllRecords(opts = {}) {
    const { index, range, count, direction = 'next', signal } = opts;
    const source = index ? this._store().index(index) : this._store();
    if (typeof source.getAllRecords === 'function') {
      try { return await ibRequestToPromise(source.getAllRecords({ query: range ?? null, count, direction }), signal); }
      catch { /* fall through to the cursor-free fallback below */ }
    }
    const [keys, values] = [await this.keys(opts), await this.getAll(opts)];
    return values.map((value, i) => ({ key: keys[i], primaryKey: keys[i], value }));
  }

  /**
   * Stream records one at a time without loading the whole store into memory:
   *   for await (const order of orders.stream({ index: 'byStatus' })) { ... }
   * Each yielded item is the record value; use streamRecords() for {key, value}.
   */
  async *stream({ index, range, direction = 'next', signal, binary = false, codec } = {}) {
    for await (const rec of this.streamRecords({ index, range, direction, signal })) {
      yield binary ? ibUnwrapValue(rec.value, { binary, codec }) : rec.value;
    }
  }

  async *streamRecords({ index, range, direction = 'next', signal } = {}) {
    ibThrowIfAborted(signal);
    const source = index ? this._store().index(index) : this._store();
    let cursorReq;
    try { cursorReq = range !== undefined ? source.openCursor(range, direction) : source.openCursor(null, direction); }
    catch { cursorReq = source.openCursor(); }
    // One deferred per cursor step: each onsuccess resolves the pending step
    // and arms a fresh deferred for the next continue() call.
    let resolveStep; let rejectStep;
    let pending = new Promise((res, rej) => { resolveStep = res; rejectStep = rej; });
    pending.catch(() => {}); // consumer may break out early; never unhandled
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      const resolve = resolveStep;
      pending = new Promise((res, rej) => { resolveStep = res; rejectStep = rej; });
      pending.catch(() => {});
      resolve(cursor ?? DONE);
    };
    cursorReq.onerror = () => rejectStep(cursorReq.error);
    let cursor = await pending;
    while (cursor !== DONE && cursor) {
      ibThrowIfAborted(signal);
      yield { key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value };
      const step = pending;
      cursor.continue();
      cursor = await step;
    }
  }

  /* ---------------- writes ---------------- */

  /** Insert or overwrite ONE record. Returns its key. Fires a 'change' event. */
  async put(record, { key, binary = false, codec, durability } = {}) {
    const value = ibWrapValue(record, { binary, codec });
    const resultKey = await this._inTx('readwrite', async (store) => {
      const req = key !== undefined && this.keyPath == null ? store.put(value, key) : store.put(value);
      return ibRequestToPromise(req);
    }, { durability });
    this._changed({ type: 'put', key: resultKey ?? key, record });
    return resultKey;
  }

  /** Insert ONE record; fails if the key already exists (store.add semantics). */
  async add(record, { key, binary = false, codec, durability } = {}) {
    const value = ibWrapValue(record, { binary, codec });
    const resultKey = await this._inTx('readwrite', async (store) => {
      const req = key !== undefined && this.keyPath == null ? store.add(value, key) : store.add(value);
      return ibRequestToPromise(req);
    }, { durability });
    this._changed({ type: 'add', key: resultKey ?? key, record });
    return resultKey;
  }

  /**
   * Write many records in ONE transaction. Accepts Array | Map | iterable.
   * Map + out-of-line keys: entries are [key, record]. Map + keyPath: values win.
   * Returns the array of keys written.
   */
  async putAll(input, { binary = false, codec, durability } = {}) {
    const entries = ibToEntries(input, this.keyPath);
    const keys = await this._inTx('readwrite', async (store) => {
      const out = [];
      for (const [key, record] of entries) {
        const value = ibWrapValue(record, { binary, codec });
        const req = key !== undefined && this.keyPath == null ? store.put(value, key) : store.put(value);
        out.push(await ibRequestToPromise(req));
      }
      return out;
    }, { durability });
    this._changed({ type: 'bulk', keys });
    return keys;
  }

  /** Sugar: putAll() for developers holding a Map<key, record>. */
  async putMap(map, opts) { return this.putAll(map, opts); }

  /**
   * Patch ONE record, in place, inside a single transaction — the granular
   * "update just this row" operation (also callable from any event handler).
   *   await orders.update(7, { status: 'paid' });                    // merge
   *   await orders.update(7, { 'customer.city': 'Oslo' });           // deep path
   *   await orders.update(7, (o) => ({ ...o, total: o.total + 1 })); // function
   * Returns the updated record, or undefined when the key does not exist
   * (pass { upsert: true } to create it from the patch instead).
   */
  async update(key, patch, { upsert = false, durability } = {}) {
    let updated;
    await this._inTx('readwrite', async (store) => {
      const current = await ibRequestToPromise(store.get(key));
      if (current === undefined && !upsert) return;
      const base = current ?? (this.keyPath ? { [this.keyPath]: key } : {});
      updated = typeof patch === 'function' ? patch(structuredClone(base)) : ibApplyPatch(base, patch);
      const req = this.keyPath == null ? store.put(updated, key) : store.put(updated);
      await ibRequestToPromise(req);
    }, { durability });
    if (updated !== undefined) this._changed({ type: 'put', key, record: updated });
    return updated;
  }

  /** Delete ONE record by key. Fires a 'change' event. */
  async delete(key, { durability } = {}) {
    await this._inTx('readwrite', async (store) => { await ibRequestToPromise(store.delete(key)); }, { durability });
    this._changed({ type: 'delete', key });
  }

  /** Delete many keys (or an IDBKeyRange) in one transaction. */
  async deleteAll(keysOrRange, { durability } = {}) {
    await this._inTx('readwrite', async (store) => {
      if (keysOrRange instanceof IDBKeyRange) { await ibRequestToPromise(store.delete(keysOrRange)); return; }
      for (const k of keysOrRange ?? []) await ibRequestToPromise(store.delete(k));
    }, { durability });
    this._changed({ type: 'bulk' });
  }

  /** Remove every record in the store (key generator is NOT reset — per spec). */
  async clear({ durability } = {}) {
    await this._inTx('readwrite', async (store) => { await ibRequestToPromise(store.clear()); }, { durability });
    this._changed({ type: 'clear' });
  }

  /** Start a fluent query over this table (see IB_pipeline.js). */
  query() {
    // Deferred require-style import avoids a module cycle at load time.
    return newQuery(this);
  }

  // Filled in by IB_pipeline.js to avoid a static import cycle.
  static _queryFactory = null;
}

function newQuery(table) {
  if (!ibTable._queryFactory) throw new ibIDB3Error('Query builder not loaded: import from IB_index.js (or IB_pipeline.js)', { code: 'NO_PIPELINE' });
  return ibTable._queryFactory(table);
}

/** Normalize Array | Map | iterable input into [key|undefined, record] entries. */
export function ibToEntries(input, keyPath) {
  if (input == null) return [];
  if (input instanceof Map) {
    return [...input.entries()].map(([k, v]) => [keyPath == null ? k : undefined, v]);
  }
  if (Array.isArray(input)) return input.map((r) => [undefined, r]);
  if (typeof input[Symbol.iterator] === 'function') return [...input].map((r) => [undefined, r]);
  if (typeof input === 'object') return [[undefined, input]]; // a single record
  throw new ibIDB3Error('putAll: expected an Array, Map, iterable, or single record', { code: 'BAD_INPUT' });
}

/** Shallow-merge a patch; dotted keys ('a.b.c') set deep paths. */
export function ibApplyPatch(record, patch) {
  const out = { ...record };
  for (const [path, value] of Object.entries(patch ?? {})) {
    if (!path.includes('.')) { out[path] = value; continue; }
    const parts = path.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
    node[parts.at(-1)] = value;
  }
  return out;
}

export { ibAbortError };
