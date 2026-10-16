// IB_demo-basic.js — the 60-second tour: tables, one-record updates, queries,
// Maps, live queries, transactions and sync. Run it in any page (module
// script) or paste pieces into your app. No build step, no dependencies.

import {
  ibOpenDatabase, ibCreateSyncEngine, ibFetchSyncAdapter, ibWorkOrderStores, ibSeedWorkOrder,
} from './IB_index.js';

// 1) Open + seed ------------------------------------------------------------
const db = await ibOpenDatabase({ name: 'workdb', version: 1, stores: ibWorkOrderStores });
const seed = ibSeedWorkOrder();
for (const [store, rows] of Object.entries(seed)) await db.table(store).putAll(rows);

// 2) Single-record, granular operations ------------------------------------
//    (call these from a button click, a grid row edit, any event handler)
const orders = db.table('workOrders');
await orders.put({ id: 'WO-2', title: 'Inspect valve', status: 'open', createdAt: '2026-01-05' });
await orders.update('WO-2', { status: 'done' });                    // patch one field
await orders.update('WO-2', (o) => ({ ...o, title: `${o.title} ✓` })); // computed patch
console.log(await orders.get('WO-2'));

// 3) Fluent pipeline query (inspectable stage by stage) ----------------------
const { rows, total, plan } = await db.from('workOrders')
  .where({ status: 'open' })              // uses the byStatus index (see plan)
  .search('pump', ['title'])
  .sortBy('-createdAt')
  .page(1, 20)
  .tap((stageRows, stage) => console.log(stage, stageRows.length))
  .toResult();
console.log({ rows, total, plan });

// 4) Arrays in, Maps out (and back) ------------------------------------------
const byId = await db.from('people').toMap('id');   // Map<'P-1', {…}>
await db.table('people').putMap(new Map([['P-4', { id: 'P-4', name: 'Di' }]]));
console.log(byId.get('P-1'));

// 5) Atomic multi-store transaction ------------------------------------------
//    (do any fetch() BEFORE this — awaiting non-IDB work inside kills the tx)
await db.tx(['workOrders', 'assignments'], 'readwrite', async (tx) => {
  await tx.table('workOrders').put({ id: 'WO-3', title: 'Audit', status: 'open', createdAt: '2026-01-06' });
  await tx.table('assignments').add({ workOrderId: 'WO-3', personId: 'P-1' });
}, { durability: 'strict' });

// 6) Live query: UI refreshes itself whenever the store changes -------------
const live = db.liveQuery(
  () => db.from('workOrders').where({ status: 'open' }).toArray(),
  ['workOrders'],
);
const stop = live.subscribe((open) => console.log('open orders:', open.map((o) => o.id)));

// 7) Sync with YOUR backend API ----------------------------------------------
//    Describe the REST API as data, or pass hand-written pull/push functions.
const sync = ibCreateSyncEngine(db, ibFetchSyncAdapter({
  baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push',
  headers: () => ({ Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` }),
}));
// await sync.pull();                        // server -> local
// await sync.syncOne('workOrders', 'WO-2'); // push just this one record
// sync.startAuto({ stores: ['workOrders'] }); // queue + push edits automatically

export { db, live, stop, sync };
