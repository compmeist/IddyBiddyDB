// Regression tests for change notification:
//   1. db.tx() must publish buffered changes after commit (and only then) —
//      transaction-bound table handles suppress their per-write events.
//   2. Two ordinary Database instances (no sync worker) must hear each
//      other's writes as 'remote-change' and refresh live queries.
// Runs in Node against in-memory fakes for IDB requests/transactions and
// BroadcastChannel; real-engine coverage lives in IB_browser-test.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ibDatabase } from '../IB_db.js';
import { ibBroadcastChange, ibListenRemoteChanges } from '../IB_events.js';

/* ---------------- Fake BroadcastChannel ---------------- */
// Delivers to every other live channel object with the same name —
// including a different channel object in the same "tab", which is the
// worst-case echo a Database must defend itself against (source id).
class FakeBroadcastChannel {
  static registry = new Map(); // name -> Set<channel>
  constructor(name) {
    this.name = name;
    this._listeners = new Set();
    this.closed = false;
    if (!FakeBroadcastChannel.registry.has(name)) FakeBroadcastChannel.registry.set(name, new Set());
    FakeBroadcastChannel.registry.get(name).add(this);
  }
  addEventListener(_type, fn) { this._listeners.add(fn); }
  removeEventListener(_type, fn) { this._listeners.delete(fn); }
  postMessage(data) {
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => peer._deliver({ data }));
    }
  }
  _deliver(event) {
    for (const fn of this._listeners) fn(event);
    this.onmessage?.(event);
  }
  close() {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}
globalThis.BroadcastChannel = FakeBroadcastChannel;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Fake IndexedDB (just enough for Table/tx) ---------------- */
function fakeRequest(result) {
  const req = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

function makeFakeRaw(name, sharedData) {
  // Two "tabs" pass the same sharedData: real tabs share one IndexedDB.
  const data = sharedData ?? { orders: new Map(), stock: new Map() };
  const makeStore = (storeName) => ({
    put: (value, key) => {
      const k = key ?? value?.id;
      data[storeName].set(k, value);
      return fakeRequest(k);
    },
    add: (value, key) => {
      const k = key ?? value?.id;
      data[storeName].set(k, value);
      return fakeRequest(k);
    },
    get: (key) => fakeRequest(data[storeName].get(key)),
    delete: (key) => { data[storeName].delete(key); return fakeRequest(undefined); },
    clear: () => { data[storeName].clear(); return fakeRequest(undefined); },
    getAll: () => fakeRequest([...data[storeName].values()]),
  });
  const raw = {
    name,
    version: 1,
    data,
    objectStoreNames: Object.assign(['orders', 'stock'], { contains: (n) => ['orders', 'stock'].includes(n) }),
    transaction(storeNames) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      let oncomplete = null;
      const tx = {
        objectStore: (n) => {
          if (!names.includes(n)) throw new Error(`store ${n} not in transaction scope`);
          return makeStore(n);
        },
        onerror: null,
        onabort: null,
        error: null,
      };
      // ibTxDone() assigns oncomplete; committing on the next microtask
      // stands in for the real transaction finishing.
      Object.defineProperty(tx, 'oncomplete', {
        get: () => oncomplete,
        set: (fn) => { oncomplete = fn; queueMicrotask(() => fn?.()); },
      });
      return tx;
    },
    close() { this.closed = true; },
  };
  return raw;
}

const STORE_DEFS = [
  { name: 'orders', keyPath: 'id', autoIncrement: false, indexes: [] },
  { name: 'stock', keyPath: 'id', autoIncrement: false, indexes: [] },
];

function fakeDb(name, { data, ...opts } = {}) {
  return new ibDatabase(makeFakeRaw(name, data), { storeDefs: STORE_DEFS, broadcast: false, ...opts });
}

/* ---------------- 1. transaction notifications ---------------- */

test('tx: changes are buffered during the tx and published once per store on commit', async () => {
  const db = fakeDb('tx-commit');
  const seen = [];
  db.on('change', (e) => seen.push(e.detail));

  let seenInsideTx = null;
  await db.tx(['orders', 'stock'], 'readwrite', async (tx) => {
    await tx.table('orders').put({ id: 1, total: 10 });
    await tx.table('stock').put({ id: 's1', qty: 3 });
    seenInsideTx = seen.length;
  });

  assert.equal(seenInsideTx, 0, 'no change may leak before commit');
  assert.equal(seen.length, 2, 'one notification per touched store');
  assert.deepEqual(
    seen.map((c) => [c.store, c.type, c.key]),
    [['orders', 'put', 1], ['stock', 'put', 's1']],
  );
  db.close();
});

test('tx: several writes to one store collapse to a single bulk notification', async () => {
  const db = fakeDb('tx-bulk');
  const seen = [];
  db.on('change', (e) => seen.push(e.detail));

  await db.tx(['orders'], 'readwrite', async (tx) => {
    await tx.table('orders').put({ id: 1 });
    await tx.table('orders').put({ id: 2 });
    await tx.table('orders').delete(1);
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].store, 'orders');
  assert.equal(seen[0].type, 'bulk');
  assert.deepEqual(seen[0].keys, [1, 2, 1]);
  assert.equal(seen[0].changes.length, 3, 'per-write detail is preserved for consumers like sync startAuto');
  db.close();
});

test('tx: liveQuery refreshes after a multi-store transaction commits', async () => {
  const db = fakeDb('tx-live');
  const live = db.liveQuery(() => db.table('orders').getAll(), ['orders']);
  const lengths = [];
  live.subscribe((rows) => lengths.push(rows.length));
  await tick();

  await db.tx(['orders', 'stock'], 'readwrite', async (tx) => {
    await tx.table('orders').put({ id: 1 });
    await tx.table('stock').put({ id: 's1' });
  });
  await tick();

  assert.equal(lengths.at(-1), 1);
  live.dispose();
  db.close();
});

test('tx: a throwing callback publishes nothing', async () => {
  const db = fakeDb('tx-abort');
  const seen = [];
  db.on('change', (e) => seen.push(e.detail));

  await assert.rejects(
    db.tx(['orders'], 'readwrite', async (tx) => {
      await tx.table('orders').put({ id: 1 });
      throw new Error('boom');
    }),
    /boom/,
  );
  await tick();
  assert.equal(seen.length, 0);
  db.close();
});

/* ---------------- 2. cross-tab updates without a worker ---------------- */

test('cross-tab: a second ordinary Database hears remote-change and refreshes its liveQuery, with no worker', async () => {
  const name = `cross-tab-${Date.now()}`;
  const shared = { orders: new Map(), stock: new Map() };
  const tabA = fakeDb(name, { broadcast: true, data: shared });
  const tabB = fakeDb(name, { broadcast: true, data: shared });

  const remoteSeen = [];
  tabB.on('remote-change', (e) => remoteSeen.push(e.detail));

  const live = tabB.liveQuery(async () => tabB.raw.data.orders.size, ['orders']);
  const values = [];
  live.subscribe((v) => values.push(v));
  await tick();

  // A write in tab A (exactly what Table._changed -> _emitChange sends).
  tabA.raw.data.orders.set(7, { id: 7 });
  tabA._emitChange({ store: 'orders', type: 'put', key: 7 });
  await tick();

  assert.equal(remoteSeen.length, 1);
  assert.deepEqual([remoteSeen[0].store, remoteSeen[0].type, remoteSeen[0].key], ['orders', 'put', 7]);
  assert.equal(values.at(-1), 1, 'liveQuery in the other tab refreshed');

  live.dispose();
  tabA.close();
  tabB.close();
});

test('cross-tab: a tab never hears its own broadcast as remote-change, and close() stops listening', async () => {
  const name = `cross-tab-self-${Date.now()}`;
  const tabA = fakeDb(name, { broadcast: true });
  const tabB = fakeDb(name, { broadcast: true });
  const aRemote = [];
  const bRemote = [];
  tabA.on('remote-change', (e) => aRemote.push(e.detail));
  tabB.on('remote-change', (e) => bRemote.push(e.detail));

  tabA._emitChange({ store: 'orders', type: 'put', key: 1 });
  await tick();
  assert.equal(aRemote.length, 0, 'own broadcast must not echo back as remote');
  assert.equal(bRemote.length, 1);

  tabB.close();
  tabA._emitChange({ store: 'orders', type: 'put', key: 2 });
  await tick();
  assert.equal(bRemote.length, 1, 'closed database no longer receives');

  tabA.close();
});

test('events: ibListenRemoteChanges ignores its own source but accepts worker-style sourceless messages', async () => {
  const seen = [];
  const stop = ibListenRemoteChanges('events-unit', (c) => seen.push(c), { sourceId: 'me' });
  ibBroadcastChange('events-unit', { store: 'orders', type: 'put', key: 1 }, 'me');
  ibBroadcastChange('events-unit', { store: 'orders', type: 'put', key: 2 }, 'other-tab');
  ibBroadcastChange('events-unit', { store: 'stock', type: 'bulk', origin: 'worker' });
  await tick();
  assert.deepEqual(seen.map((c) => c.store), ['orders', 'stock']);
  assert.deepEqual(seen.map((c) => c.key), [2, undefined]);
  stop();
});
