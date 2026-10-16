// IB_demo-grid.js — Web Awesome <wa-data-grid> wired to IndexedDB, both ways.
// Assumes a page with: <wa-data-grid id="grid" server paginate></wa-data-grid>
// and the Web Awesome script loaded. See README.md for the full walkthrough.

import { ibOpenDatabase, ibBindDataGrid, ibCreateDataSource, ibSeedWorkOrder, ibWorkOrderStores } from './IB_index.js';

const db = await ibOpenDatabase({ name: 'workdb', version: 1, stores: ibWorkOrderStores });

// Seed once (demo only — real apps pull this from the server via IB_sync.js).
if ((await db.table('workOrders').count()) === 0) {
  const seed = ibSeedWorkOrder();
  for (const [store, rows] of Object.entries(seed)) await db.table(store).putAll(rows);
}

const config = {
  baseStore: 'workOrders',
  nest: {
    via: 'link', links: 'assignments', targets: 'people',
    parentKey: 'id', linkParent: 'workOrderId', linkTarget: 'personId', targetKey: 'id',
    as: 'assignees',
  },
  searchFields: ['title', 'status'],
};

// --- Way B (events): one line. Handles wa-data-request, loading, aborts. ---
const grid = document.querySelector('#grid');
const unbind = ibBindDataGrid(grid, db, { ...config, db }, { live: true });

// --- Way A (callback): equivalent, if you prefer assigning dataSource. ---
// grid.dataSource = ibCreateDataSource(db, config);

// Rows come back nested: rows[0] = { id:'WO-1', title:'Fix pump',
//   status:'open', createdAt:'2026-01-04', assignees:[{...} x3] }
//
// Cleanup when the page/component goes away: unbind();
export { db, unbind };
