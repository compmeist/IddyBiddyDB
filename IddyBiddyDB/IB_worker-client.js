// IB_worker-client.js — main-thread side of IB_sync-worker.js.
//
//   import { ibOpenDatabase, ibCreateSyncWorker } from './IB_index.js';
//   const db = await ibOpenDatabase({ name: 'shop', stores: { orders: 'id' } });
//   const worker = ibCreateSyncWorker({
//     db,  // or just { name: 'shop' } — used for cross-tab notifications
//     init: { db: { name: 'shop', stores: { orders: 'id' } },
//             sync: { baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push' } },
//   });
//   await worker.sync();                 // pull + push inside the worker
//   await worker.syncOne('orders', 42);  // flush one record
//   worker.terminate();
//
// When the worker applies server data it broadcasts on
// BroadcastChannel('idb3:<name>'); this client forwards those messages into
// your Database as 'remote-change', so liveQuery() and ibBindDataGrid(live)
// refresh automatically. No polling anywhere.

import { ibListenRemoteChanges } from './IB_events.js';

export class ibSyncWorkerClient {
  /**
   * @param {object} opts
   * @param {string|URL} [opts.workerUrl] defaults to ./IB_sync-worker.js next to this file
   * @param {object} [opts.init] payload for the worker's init (db + sync spec)
   * @param {object} [opts.db] Database wrapper (or { name }) to notify on remote changes
   */
  constructor({ workerUrl, init, db } = {}) {
    const url = workerUrl ?? new URL('./IB_sync-worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
    this._seq = 0;
    this._pending = new Map();
    this.worker.addEventListener('message', (event) => {
      const { id, ok, result, error } = event.data ?? {};
      const entry = this._pending.get(id);
      if (!entry) return;
      this._pending.delete(id);
      if (ok) entry.resolve(result);
      else { const err = new Error(error?.message ?? 'Worker error'); err.name = error?.name ?? 'Error'; entry.reject(err); }
    });
    this._initPayload = init;
    this._ready = init ? this.call('init', init) : Promise.resolve(null);
    const name = db?.name ?? init?.db?.name ?? init?.name;
    this._stopRemote = name && db?._emitRemoteChange
      ? ibListenRemoteChanges(name, (change) => db._emitRemoteChange(change))
      : () => {};
  }

  /** Low-level request/response call. Prefer pull()/push()/sync() below. */
  async call(type, payload) {
    await (type === 'init' ? Promise.resolve() : this._ready);
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  pull() { return this.call('pull'); }
  push() { return this.call('push'); }
  sync() { return this.call('sync'); }
  syncOne(store, key) { return this.call('syncOne', { store, key }); }
  pullOne(store, key) { return this.call('pullOne', { store, key }); }

  terminate() { this._stopRemote(); this.worker.terminate(); }
}

export function ibCreateSyncWorker(opts) { return new ibSyncWorkerClient(opts); }
