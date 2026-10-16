// IB_sync-worker.js — a ready-made Web Worker that keeps IndexedDB in sync
// with your server off the main thread. The UI stays smooth while pulls and
// pushes happen here; other tabs learn about new data over BroadcastChannel
// (listen with ibListenRemoteChanges() / Database._emitRemoteChange()).
//
// Functions cannot cross postMessage, so the worker's sync is described as
// DATA: a fetchSyncAdapter spec ({ baseUrl, pullPath, pushPath, headers }).
// For hand-written pull/push logic, copy this file and edit `makeEngine()`.
//
// Launch it from the page with IB_worker-client.js:
//   const worker = ibCreateSyncWorker({ db: { name, stores }, sync: { baseUrl } });
//   await worker.sync();
//
// Protocol:  page -> worker  { id, type: 'init'|'pull'|'push'|'sync'|'syncOne'|'pullOne', payload }
//            worker -> page  { id, ok: true, result } | { id, ok: false, error }

import { ibOpenDatabase } from './IB_db.js';
import { ibCreateSyncEngine, ibFetchSyncAdapter } from './IB_sync.js';

let db = null;
let engine = null;
let dbName = 'app';

function broadcast(store) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(`idb3:${dbName}`);
  try { channel.postMessage({ kind: 'idb3-change', change: { store, type: 'bulk', origin: 'worker' } }); }
  finally { channel.close(); }
}

async function init(payload = {}) {
  dbName = payload.db?.name ?? payload.name ?? dbName;
  db = await ibOpenDatabase(payload.db ?? payload);
  const spec = payload.sync ?? {};
  engine = ibCreateSyncEngine(db, typeof spec.pull === 'string' || spec.baseUrl || spec.pullPath
    ? ibFetchSyncAdapter(spec)
    : spec);
  // After a pull lands, tell every tab so grids/live queries can refresh.
  engine.on('pulled', () => broadcast('*'));
  engine.on('synced-one', ({ store }) => broadcast(store));
  return { name: db.name, stores: db.storeNames };
}

const handlers = {
  init,
  pull: () => engine.pull(),
  push: () => engine.push(),
  sync: () => engine.sync(),
  syncOne: ({ store, key }) => engine.syncOne(store, key),
  pullOne: ({ store, key }) => engine.pullOne(store, key),
};

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    if (type !== 'init' && !engine) throw new Error('sync-worker: send { type: "init" } first');
    const result = await handlers[type]?.(payload);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: { message: String(err?.message ?? err), name: err?.name } });
  }
});
