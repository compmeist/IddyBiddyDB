# IddyBiddyDB — a friendly shim for IndexedDB 3

IndexedDB is the browser's built-in database ([W3C IndexedDB 3.0](https://www.w3.org/TR/IndexedDB/)).
It is fast, transactional and works offline — but its native API is
event-based and verbose. This library wraps it in Promises and gives you
three simple ideas:

1. **Tables** — `db.table('orders')` with `get / put / update / delete`.
2. **Pipelines** — `db.from('orders').where(...).sortBy(...).page(...)` queries
   you can inspect stage by stage.
3. **Sync** — local-first reads/writes with an outbox that flushes to *your*
   server API, on the main thread or in a Web Worker.

No dependencies, no build step, no SQL. Plain ES modules using modern
JavaScript (`??`, `?.`, logical assignment, `Array.at`, async iterators).
Works on IndexedDB 2 engines too — IndexedDB 3 additions
(`indexedDB.databases()`, transaction `durability`, `getAll({query,count,direction})`,
`getAllRecords()`) are feature-detected, never assumed.

**Full documentation:** [USER_MANUAL.md](USER_MANUAL.md) — concepts,
CRUD, query pipelines, live queries and cross-tab updates, grids,
sync (main thread and worker), codecs, troubleshooting, and an API
quick reference. This README is the short overview.

---

## 60-second start

```js
import { ibOpenDatabase } from './IddyBiddyDB/IB_index.js';

const db = await ibOpenDatabase({
  name: 'shop',
  version: 1,
  stores: {
    orders: { keyPath: 'id', indexes: { byStatus: 'status', byCreated: 'createdAt' } },
    people: 'id',                    // shorthand: just the key property
    outbox: { keyPath: 'seq', autoIncrement: true },  // only needed for sync
    meta: 'key',                                      // only needed for sync
  },
});

await db.table('orders').put({ id: 1, total: 42, status: 'open' });
const order = await db.table('orders').get(1);
```

A *store* is a table. `keyPath: 'id'` means "the record's `id` property is
its key". An *index* is a sorted copy of one property that makes lookups on
it fast — declare one for every field you filter/sort by often.

---

## Tables: the everyday API

```js
const orders = db.table('orders');

await orders.put(record);              // insert or overwrite one record
await orders.add(record);              // insert; fails if the key exists
await orders.putAll(arrayOrMap);       // many records, ONE transaction
await orders.get(key);                 // one record (or undefined)
await orders.getAll();                 // everything (careful on huge stores)
await orders.getAllAsMap();            // Map<key, record>
await orders.count();
await orders.delete(key);
await orders.clear();
for await (const o of orders.stream()) { /* one at a time, low memory */ }
```

### Update ONE record (the granular operation)

```js
await orders.update(7, { status: 'paid' });                     // merge patch
await orders.update(7, { 'customer.city': 'Oslo' });            // deep path
await orders.update(7, (o) => ({ ...o, total: o.total + 1 }));  // function patch
await orders.update(7, { status: 'paid' }, { upsert: true });   // create if missing
```

`update` reads and writes inside a single transaction, so it is safe to call
from a button click, a grid row edit, or any event handler — no
read-modify-write race.

### Working with Maps

Developers holding `Map<key, record>` (or wanting one back) never convert
by hand:

```js
await orders.putMap(myMap);                       // Map in
const byId = await orders.getAllAsMap();          // Map out
const byId2 = await db.from('orders').toMap('id');
```

Records may contain nested objects/arrays and `Map`/`Set`/`Date`/`Blob`
values — IndexedDB stores them natively (structured clone). Only the
optional binary codec (below) needs help with them, and it has it.

### Transactions across stores

```js
await db.tx(['orders', 'stock'], 'readwrite', async (tx) => {
  await tx.table('orders').put(order);
  await tx.table('stock').update(itemId, (s) => ({ ...s, qty: s.qty - 1 }));
}, { durability: 'strict' });   // IDB 3: fsync before commit ('relaxed' for caches)
```

> **Classic trap:** a transaction auto-commits the moment you `await`
> something that is not an IndexedDB request (`fetch`, timers...). Do that
> work *before* opening the transaction.

---

## Pipelines: queries at every granularity

```js
const { rows, total, plan } = await db.from('workOrders')
  .join('people', { type: 'lookup', localField: 'ownerId', as: 'owner' })
  .where({ status: 'open', total: { $gte: 100 } })
  .search('pump', ['title', 'status'])
  .sortBy('-createdAt')
  .page(1, 20)                 // 1-based
  .toResult();
```

A query is a pipeline of named stages that run in the order you add them.
You can stop and look at the data at *each* stage:

```js
const q = db.from('workOrders').where({ status: 'open' }).sortBy('title');
q.explain();                            // { source: { strategy: 'index', index: 'byStatus' }, steps: [...] }
await q.tap((rows, stage) => console.log(stage, rows.length)).toArray();
const { stages } = await q.runWithStages();  // Map: 'source' -> [...], 'filter' -> [...], ...
```

When the first `where()` filters on an indexed field with `eq` or a range,
the planner reads through that index instead of scanning the whole store
(the in-memory filter still runs, so results never change — only speed).
Terminals: `.toArray()`, `.toResult()`, `.first()`, `.count()`,
`.toMap(key)`, and `.stream()` (filter/search only, row at a time).

### Filters: Mongo flavour, SQL power (subset)

```js
.where({ status: 'open' })                                  // equals
.where({ total: { $gte: 100, $lt: 500 } })                  // range
.where({ status: { $in: ['open', 'held'] } })
.where({ title: { $contains: 'pump' } })                    // also $startsWith/$endsWith
.where({ tags: { $hasAny: ['urgent'] } })                   // array fields
.where({ 'customer.city': 'Oslo' })                         // dotted paths
.where({ 'assignees.name': 'Ada' })                         // matches if ANY element matches
.where({ $or: [{ status: 'open' }, { priority: 'high' }] })
.where((row) => row.total > 100)                            // plain function, always available
```

Legacy array filters (`[{ field, op, value }]`) work too. Operators:
`eq ne lt lte gt gte in nin between contains startsWith endsWith exists
hasAny hasAll`.

### Joins, nesting, grouping

```js
.join('people', { type: 'inner', leftKey: 'ownerId', rightKey: 'id', merge })  // or 'left'
.join('people', { type: 'lookup', localField: 'ownerId', as: 'owner' })        // attach one
.nest({ via: 'direct', children: 'items', parentKey: 'id', childKey: 'orderId', as: 'items' })
.nest({ via: 'link', links: 'assignments', targets: 'people', /* ... */ as: 'assignees' })
.unnest('items', { as: 'item' })            // one row per array element
.groupBy('status', { count: true, revenue: { sum: 'total' } })
.select('id', 'title')                      // projection (SQL SELECT list)
```

The pure helpers behind these (`ibApplyFilters`, `ibInnerJoin`, `ibGroupRows`,
`ibAggregateBy`, ...) are exported from `IB_query.js`/`IB_join.js` and work on any
array — handy for unit tests and non-database data. All public exports carry
the `ib` prefix (`ibOpenDatabase`, `ibTable`, `ibQuery`, ...) so they never
collide with names in consuming code; methods on those objects (`table()`,
`put()`, `where()`, ...) stay unprefixed because they are already scoped.

---

## Web Awesome `<wa-data-grid>` (and friends)

In server mode the grid emits `wa-data-request` with detail
`{ sort: [{id, desc}], filters: [{id, value}], search, page /* 0-based */,
pageSize, signal }`. Two ways to serve it from IndexedDB:

```js
import { ibBindDataGrid, ibCreateDataSource } from './IddyBiddyDB/IB_index.js';

// A) events — one line; handles loading + aborts, live-refresh optional:
ibBindDataGrid(grid, db, { baseStore: 'workOrders', searchFields: ['title', 'status'],
                         filterTypes: { total: 'number-range', tags: 'includes-any' } },
             { live: true });

// B) callback — the grid manages loading itself:
grid.dataSource = ibCreateDataSource(db, { baseStore: 'workOrders', /* ... */ });
```

Column filter values are translated by `filterTypes` (`text`, `equals`,
`number-range`, `date-range`, `set`, `includes-any`, `includes-all`);
without it, strings become substring matches and arrays become `in` lists
(or ranges for fields listed in `rangeFields`). Other components emitting a
similar detail shape can use `ibCreateDataRequestHandler(db, config)` or the
fetch-shaped `ibFetchFromIDB3(detail, config)` (`await res.json()` gives
`{ rows, total }`). See `IB_demo-grid.js`.

---

## Sync: the caching layer between UI and server

Local writes are instant; the server catches up through an *outbox*.

```js
import { ibCreateSyncEngine, ibFetchSyncAdapter } from './IddyBiddyDB/IB_index.js';

// Describe your REST API as data...
const sync = ibCreateSyncEngine(db, ibFetchSyncAdapter({
  baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push',
  headers: () => ({ Authorization: `Bearer ${token()}` }),
}));
// ...or hand-write the two functions for ANY backend (GraphQL, RPC, files):
const sync2 = ibCreateSyncEngine(db, {
  pull: async (since) => myApi.pullChanges(since),   // -> { changes: [{store, record}], seq }
  push: async (batch) => myApi.pushChanges(batch),   // throw = keep queued, retry later
  resolve: 'last-write-wins',                        // or 'server-wins' | 'client-wins' | 'merge' | fn
});

await sync.pull();                          // server -> local
await sync.syncOne('orders', orderId);      // push JUST this one record, now
await sync.push();                          // flush everything queued
sync.startAuto({ stores: ['orders'] });     // queue edits + push on change/online
```

Conventions: deletes travel as `{ _deleted: true }` tombstones; progress is
remembered in the `meta` store (`syncSeq`); the engine never echoes
server-applied changes back into the outbox. Events: `pulled`, `pushed`,
`synced`, `synced-one`, `push-failed` via `sync.on(...)`.

**In a Web Worker** (pull/push off the main thread): `IB_demo-worker.js` +
`IB_sync-worker.js` + `ibCreateSyncWorker(...)`. Fresh data is announced over
`BroadcastChannel`, so grids and live queries in every tab refresh without
polling. Functions can't cross `postMessage`, so the worker takes the
serializable `ibFetchSyncAdapter` spec — copy `IB_sync-worker.js` and edit
`makeEngine()` if you need custom logic there.

**Live UI without sync:** `db.liveQuery(run, ['orders'])` re-runs a query
whenever a listed store changes in this tab, another tab, or the worker;
`db.on('change', ...)` gives raw `{ store, type, key, record }` events.

---

## Optional binary stores (codecs)

```js
import { ibRegisterCodec } from './IddyBiddyDB/IB_index.js';
await db.table('snapshots').put(snapshot, { binary: true });        // JSON->Uint8Array
const back = await db.table('snapshots').get(id, { binary: true }); // Map/Set/Date survive
ibRegisterCodec('msgpack', { encode, decode });                     // plug your own
```

Default (no `binary`) is structured-clone passthrough — prefer it unless
you specifically need compact bytes on disk.

---

## Upgrades and housekeeping

```js
const db = await ibOpenDatabase({
  name: 'shop', version: 2, stores: { /* new/changed stores */ },
  upgrade(db, tx, oldVersion, newVersion) { /* one-off data migrations */ },
});
await ibListDatabases();        // IDB 3 indexedDB.databases() ([] if unsupported)
await ibDeleteDatabase('old');
```

If another tab holds an older version open, opening blocks: this library
closes politely on `versionchange` and rejects `ibOpenDatabase` with a clear
`BLOCKED` error instead of hanging silently.

## Files

| File | What it is |
| --- | --- |
| `IB_index.js` | Public entry point — import from here |
| `IB_db.js` | Open/upgrade, `ibDatabase`, transactions, durability |
| `IB_table.js` | One-store handle: CRUD, `update()`, Maps, streaming |
| `IB_pipeline.js` | Fluent `ibQuery`: stages, `tap`/`explain`/`runWithStages` |
| `IB_query.js` | Pure filter/search/sort/group/aggregate engine + index planner |
| `IB_join.js` | Hash joins, lookup, nesting, unnest |
| `IB_grid-adapter.js` | `wa-data-grid` / generic data-request wiring |
| `IB_sync.js` | `ibSyncEngine`, outbox, conflicts, REST adapter |
| `IB_sync-worker.js` / `IB_worker-client.js` | Worker sync + main-thread client |
| `IB_codecs.js` | Optional binary encoding (Map/Set/Date-aware JSON) |
| `IB_events.js` | Change bus + cross-tab BroadcastChannel |
| `IB_schemas.js`, `IB_demo-*.js` | Examples: work-orders schema, grid/basic/worker demos |

## Page indexing at zero

The grid adapter treats `page` as **0-based** (matching current Web Awesome), and `ibOpenDatabase`
returns the `ibDatabase` wrapper (the raw handle is `.raw`) so `db.table()`
is available everywhere the old code passed `db` around.
