// IB_demo-worker.js — sync in a Web Worker: pull/push off the main thread,
// grids refresh themselves when fresh server data lands.
//
// The worker (IB_sync-worker.js) owns its own database connection — IndexedDB
// is available in workers, and short transactions keep tabs/workers from
// clashing. After each pull it broadcasts; ibCreateSyncWorker forwards that
// into `db` as 'remote-change', which liveQuery/bindDataGrid already hear.

import { ibOpenDatabase, ibCreateSyncWorker, ibBindDataGrid, ibWorkOrderStores } from './IB_index.js';

const db = await ibOpenDatabase({ name: 'workdb', version: 1, stores: ibWorkOrderStores });

const worker = ibCreateSyncWorker({
  db, // forwards worker broadcasts into this Database as 'remote-change'
  init: {
    db: { name: 'workdb', version: 1, stores: ibWorkOrderStores },
    sync: { baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push' },
  },
});

// Kick off a full sync in the background; keep editing locally meanwhile.
await worker.sync();

// Live grid: refreshes on local edits AND on worker-delivered server data.
const grid = document.querySelector('#grid');
if (grid) {
  ibBindDataGrid(grid, db, {
    baseStore: 'workOrders', searchFields: ['title', 'status'],
  }, { live: true });
}

// When the page goes away: worker.terminate();
export { db, worker };
