# IddyBiddyDB — User Manual

A friendly, Promise-based shim for IndexedDB 3.

IndexedDB is the browser's built-in database: fast, transactional, and
available offline. Its native API is event-based and verbose. IddyBiddyDB
wraps it in Promises and gives you three simple ideas:

1. **Tables** — `db.table('orders')` with `get / put / update / delete`.
2. **Pipelines** — fluent queries such as
   `db.from('orders').where(...).sortBy(...).page(...)`.
3. **Sync** — local-first reads and writes, with an outbox that flushes to
   your own server API, on the main thread or in a Web Worker.

There are no dependencies and no build step. The library is plain ES
modules using modern JavaScript. IndexedDB 3 additions
(`indexedDB.databases()`, transaction `durability`, `getAll()` options,
`getAllRecords()`) are feature-detected, so the same code also runs on
IndexedDB 2 engines.

> **New here?** Read [Quick start](#quick-start), then
> [Tables: everyday CRUD](#tables-everyday-crud). Everything else is
> optional and can be adopted one layer at a time.

---

## Contents

- [Concepts in 60 seconds](#concepts-in-60-seconds)
- [Importing the library](#importing-the-library)
- [Quick start](#quick-start)
- [Opening a database](#opening-a-database)
- [Tables: everyday CRUD](#tables-everyday-crud)
- [Transactions across stores](#transactions-across-stores)
- [Queries: the pipeline](#queries-the-pipeline)
- [Live queries and change events](#live-queries-and-change-events)
- [Cross-tab updates](#cross-tab-updates)
- [Data grids and data-request components](#data-grids-and-data-request-components)
- [Sync: IndexedDB as a cache for your server](#sync-indexeddb-as-a-cache-for-your-server)
- [Sync in a Web Worker](#sync-in-a-web-worker)
- [Optional binary stores (codecs)](#optional-binary-stores-codecs)
- [Upgrades, errors, and housekeeping](#upgrades-errors-and-housekeeping)
- [Pure helpers (no database needed)](#pure-helpers-no-database-needed)
- [Examples and demos](#examples-and-demos)
- [Troubleshooting](#troubleshooting)
- [API quick reference](#api-quick-reference)
- [Testing](#testing)

---

## Concepts in 60 seconds

| Term | Meaning |
| --- | --- |
| Database | One named IndexedDB database, opened with `ibOpenDatabase()`. |
| Store (table) | A named collection of records inside the database, e.g. `orders`. Think "table". |
| Record | One JavaScript value stored under a key. Usually an object. |
| Key | What identifies a record. Either taken from a record property (`keyPath`, e.g. `id`) or supplied separately ("out-of-line" keys). |
| Index | A sorted copy of one record property. Declare one for fields you filter or sort by often; queries on indexed fields are fast. |
| Transaction | IndexedDB's unit of atomicity. Writes inside one transaction commit together or roll back together. This library creates transactions for you; `db.tx()` lets you span several stores in one. |
| Pipeline | A fluent query: readable stages (`where`, `sortBy`, `page`, ...) run in the order you write them. |
| Outbox | A store where the sync layer queues local mutations until they can be pushed to your server. |

Records may contain nested objects and arrays, and `Map`, `Set`, `Date`,
`Blob`, and `ArrayBuffer` values: IndexedDB stores them natively via
structured clone. Field paths in filters, patches, and sorts use dots,
e.g. `'customer.city'`.

---

## Importing the library

Serve the `IddyBiddyDB` folder over HTTP (ES modules do not load from
`file://`) and import from the public entry point:

```js
import { ibOpenDatabase } from './IddyBiddyDB/IB_index.js';
```

Adjust the relative path to where the folder lives in your project.
Import only what you need — everything public is exported from
`IB_index.js`, and every public name carries the `ib` prefix so it cannot
collide with names in your own code. (Methods such as `put()` and
`where()` are unprefixed because they are already scoped to an object.)

If you only need one layer, you may import a single module instead, e.g.
`IB_db.js` + `IB_table.js` for plain CRUD. Most users should simply use
`IB_index.js`.

---

## Quick start

```js
import { ibOpenDatabase } from './IddyBiddyDB/IB_index.js';

const db = await ibOpenDatabase({
  name: 'shop',
  version: 1,
  stores: {
    orders: { keyPath: 'id', indexes: { byStatus: 'status', byCreated: 'createdAt' } },
    people: 'id',                                       // shorthand: just the key property
    outbox: { keyPath: 'seq', autoIncrement: true },    // only needed for sync
    meta: 'key',                                        // only needed for sync
  },
});

await db.table('orders').put({ id: 1, total: 42, status: 'open' });
const order = await db.table('orders').get(1);        // { id: 1, total: 42, status: 'open' }

const open = await db.from('orders')
  .where({ status: 'open' })
  .sortBy('-createdAt')
  .toArray();
```

That is the whole everyday workflow: open once, keep the `db` handle,
and call table or pipeline methods from anywhere in your app — a button
click, a grid edit, an event handler.

---

## Opening a database

```js
const db = await ibOpenDatabase({ name, version, stores, upgrade, onBlocked, broadcast });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | *(required)* | Database name. Missing names throw `ibIDB3Error` with code `NO_NAME`. |
| `version` | `1` | Schema version. Bump it (with the store changes and/or an `upgrade` callback) to migrate an existing database. |
| `stores` | — | Store definitions, in the shorthand object form or the descriptor-array form below. Alias: `schemas` (array form). |
| `upgrade` | — | `(db, tx, oldVersion, newVersion) => void`. Extra migration code run inside the version-change transaction, after `stores` have been applied. |
| `onBlocked` | — | Called when another tab holds an older version open. The open then rejects with code `BLOCKED` instead of hanging. |
| `broadcast` | `true` | Announce this connection's writes to other tabs and hear theirs (see [Cross-tab updates](#cross-tab-updates)). Set `false` to opt this connection out of cross-tab notification entirely. |

### Describing stores

The shorthand object form maps each store name to its definition:

```js
stores: {
  orders:   { keyPath: 'id', indexes: { byStatus: 'status' } },
  people:   'id',                                  // string form: just the keyPath
  drafts:   null,                                  // null: out-of-line keys, supplied per write
  counters: { keyPath: 'id', autoIncrement: true },
  logs:     { keyPath: 'seq', autoIncrement: true,
              indexes: [{ name: 'byLevel', keyPath: 'level', unique: false }] },
}
```

Rules of the shorthand:

- A string value is the `keyPath`: `'id'` means "the record's `id`
  property is its key".
- An object value accepts `keyPath` (default `null`), `autoIncrement`
  (default `false`), and `indexes`.
- `indexes` may be an object (`{ byStatus: 'status' }`, or
  `{ byEmail: { keyPath: 'email', unique: true } }`) or an array of
  `{ name, keyPath, unique, multiEntry }` descriptors.
- A missing or `null` `keyPath` means out-of-line keys: pass the key on
  each write, e.g. `table.put(record, { key })`.

The equivalent descriptor-array form (`stores` or its legacy alias
`schemas`) is accepted and is what `ibWorkOrderSchemas` in
`IB_schemas.js` uses:

```js
stores: [
  { name: 'orders', keyPath: 'id', autoIncrement: false,
    indexes: [{ name: 'byStatus', keyPath: 'status', unique: false, multiEntry: false }] },
]
```

### The Database handle

The value returned by `ibOpenDatabase()` (an `ibDatabase`) is what you
pass around your app:

| Member | Meaning |
| --- | --- |
| `db.table(name)` | Friendly handle for one store. Cached: the same name always returns the same handle. |
| `db.from(name)` | Start a fluent query on a store (same as `db.table(name).query()`). |
| `db.tx(stores, mode, fn, opts)` | Run several stores' writes in one transaction — see [Transactions](#transactions-across-stores). |
| `db.liveQuery(run, stores)` | Self-refreshing query — see [Live queries](#live-queries-and-change-events). |
| `db.on(type, fn)` | Subscribe to `change`, `remote-change`, `versionchange`, `close`. Returns an unsubscribe function. |
| `db.storeNames` | Array of store names currently in the database. |
| `db.schemaOf(name)` | `{ name, keyPath, autoIncrement, indexes }` for one store (or `null`). |
| `db.name`, `db.version` | Database name and version. |
| `db.raw` | The raw `IDBDatabase`. Escape hatch for anything this shim does not cover. |
| `db.close()` | Stop the cross-tab listener and close the connection. |

Housekeeping free functions: `ibListDatabases()` lists this origin's
databases (IndexedDB 3; returns `[]` where unsupported), and
`ibDeleteDatabase(name)` deletes one, rejecting with code `BLOCKED`
while another tab holds it open.

---

## Tables: everyday CRUD

Get a handle once and reuse it:

```js
const orders = db.table('orders');
```

### Writing

| Method | What it does |
| --- | --- |
| `put(record, opts?)` | Insert or overwrite one record. Returns its key. |
| `add(record, opts?)` | Insert one record; fails if the key already exists. Returns its key. |
| `putAll(input, opts?)` | Write many records in **one** transaction. Returns the array of keys written. |
| `putMap(map, opts?)` | Shorthand for `putAll()` when you are holding a `Map`. |
| `update(key, patch, opts?)` | Patch one record in place (below). Returns the updated record, or `undefined` if the key does not exist. |
| `delete(key, opts?)` | Delete one record by key. |
| `deleteAll(keysOrRange, opts?)` | Delete many keys, or everything in an `IDBKeyRange`, in one transaction. |
| `clear(opts?)` | Remove every record in the store. (The key generator is not reset — that is IndexedDB's own rule.) |

Write options (`opts`): `key` (only used when the store has no
`keyPath`), `durability` (`'strict' | 'relaxed' | 'default'` transaction
durability hint, IndexedDB 3), and `binary` / `codec` for binary stores
(see [Codecs](#optional-binary-stores-codecs)).

`putAll()` input is flexible — developers think in arrays and Maps,
not requests:

```js
await orders.putAll([{ id: 1, total: 10 }, { id: 2, total: 20 }]);  // Array
await orders.putAll(new Set([{ id: 3 }, { id: 4 }]));               // any iterable
await orders.putAll({ id: 5, total: 50 });                         // a single record
await orders.putMap(new Map([[1, { id: 1, total: 10 }]]));         // Map of key -> record
await drafts.putAll(new Map([['draft-1', { text: 'hi' }]]));       // out-of-line store: Map keys are the keys
```

With a `keyPath` store, a Map's record values win: records are keyed
by their own key property, not by the Map keys. With an out-of-line
store (no `keyPath`), the Map keys are used as the record keys.

### Updating one record

`update()` is the granular "edit just this row" operation. It reads and
writes inside a single transaction, so it is safe to call from a button
click or a grid row edit — there is no read-modify-write race.

```js
await orders.update(7, { status: 'paid' });                     // merge patch
await orders.update(7, { 'customer.city': 'Oslo' });            // dotted key = deep path
await orders.update(7, (o) => ({ ...o, total: o.total + 1 }));  // function patch
await orders.update(7, { status: 'paid' }, { upsert: true });   // create from the patch if missing
```

Without `upsert`, updating a missing key is a no-op that returns
`undefined`. With `upsert: true`, the new record starts from
`{ [keyPath]: key }` and the patch is applied to that.

### Reading

| Method | What it returns |
| --- | --- |
| `get(key, opts?)` | One record, or `undefined`. `opts.index` reads through an index instead of the primary key. |
| `getKey(key, opts?)` | Only the key of the first match — a fast existence/lookup check. |
| `has(key, opts?)` | `true` if a record with that key exists. |
| `count(opts?)` | Number of records (optionally through an index / key range). |
| `keys(opts?)` | All matching primary keys. |
| `getAll(opts?)` | All matching records as an array. |
| `getAllAsMap(opts?)` | All matching records as `Map<key, record>`. |
| `getAllRecords(opts?)` | Records **with** their keys: `[{ key, primaryKey, value }]` (IndexedDB 3 `getAllRecords()`, with fallback). |
| `stream(opts?)` | `AsyncIterable` of record values, one at a time — low memory for large stores. |
| `streamRecords(opts?)` | Same stream, yielding `{ key, primaryKey, value }`. |

Read options: `index` (index name), `range` (an `IDBKeyRange`),
`count`, `direction` (`'next' | 'prev'`), `signal` (an `AbortSignal` —
aborts reject with an `AbortError`, like `fetch()`), and
`binary` / `codec` for binary stores.

```js
const order = await orders.get(1);
const open  = await orders.getAll({ index: 'byStatus', range: IDBKeyRange.only('open') });
const byId  = await orders.getAllAsMap();

for await (const order of orders.stream({ index: 'byStatus' })) {
  // one record at a time, without loading the whole store
}
```

> **Caution:** `getAll()` loads everything it matches into memory.
> Prefer a pipeline with `.page(...)`, or `stream()`, for large stores.

### Change events from writes

Every non-transactional write announces itself as a `change` event on
the database (shape `{ store, type, key?, record?, keys? }` with
`type` one of `put | add | delete | clear | bulk`). Live queries,
grid bindings, and sync all build on this — see
[Live queries and change events](#live-queries-and-change-events).
Writes made through an explicit `db.tx()` transaction follow the
deferred rule described in the next section.

---

## Transactions across stores

Use `db.tx()` when several stores must change together — all the
writes commit, or none of them do:

```js
await db.tx(['orders', 'stock'], 'readwrite', async (tx) => {
  await tx.table('orders').put(order);
  await tx.table('stock').update(itemId, (s) => ({ ...s, qty: s.qty - 1 }));
}, { durability: 'strict' });   // optional IndexedDB 3 durability hint
```

- The first argument is one store name or an array of them; the second
  is `'readonly'` or `'readwrite'`; the callback receives a transaction
  handle with `.table(name)` and `.raw` (the raw `IDBTransaction`).
- **Use the `tx.table(...)` handles inside the callback, not
  `db.table(...)`.** Handles from `db.table()` open their own separate
  transactions and are not part of the atomic unit.
- `db.tx()` returns whatever your callback returns.
- If the callback throws, or any request fails, the transaction aborts
  and every write in it is rolled back. The promise rejects.

> **Classic IndexedDB trap:** a transaction auto-commits as soon as you
> `await` something that is not an IndexedDB request (`fetch()`, a
> timer, a user prompt...). Do that work **before** opening the
> transaction, and keep the callback to database calls only.

### Change notification for transactions

Per-write events are deliberately **deferred** for transaction-bound
handles: subscribers must never be told about data that a later abort
rolls back. When (and only when) the transaction commits, `db.tx()`
publishes the buffered writes — **one notification per touched store**:

- a store written once keeps its exact change,
  e.g. `{ store: 'orders', type: 'put', key: 1, record: {...} }`;
- a store written several times produces one
  `{ store, type: 'bulk', keys: [...], changes: [...] }`, where
  `changes` preserves each individual write for consumers that need
  per-record detail (such as sync's auto mode).

The practical consequence: `liveQuery()`, `db.on('change', ...)`,
cross-tab notification, and live grid bindings all refresh after a
committed multi-store transaction, exactly as they do after ordinary
writes — and stay silent after an aborted one.

---

## Queries: the pipeline

Start a query with `db.from(store)` (or `table.query()`), add stages,
and finish with a terminal:

```js
const { rows, total, plan } = await db.from('workOrders')
  .join('people', { type: 'lookup', localField: 'ownerId', as: 'owner' })
  .where({ status: 'open', total: { $gte: 100 } })
  .search('pump', ['title', 'status'])
  .sortBy('-createdAt')
  .page(1, 20)                 // 1-based
  .toResult();
```

A query is a pipeline of named stages that run **in the order you add
them**: source → join/nest → filter → search → sort → group →
project → page (that is the typical order; yours is whatever you
wrote). Queries are lazy — nothing reads the database until a terminal
runs.

### Filtering: `.where(...)`

Three equivalent dialects — use whichever reads better:

```js
.where({ status: 'open', total: { $gte: 100 } })       // Mongo-style (recommended)
.where([{ field: 'status', op: 'eq', value: 'open' }]) // legacy array style
.where((row) => row.total > 100)                       // plain function
```

Calling `.where()` more than once ANDs the conditions together.

Mongo-style operators:

| Operator | Meaning | Operator | Meaning |
| --- | --- | --- | --- |
| `$eq` / `$ne` | equals / not equals | | `$in` / `$nin` | in list / not in list |
| `$lt` / `$lte` | less than (or equal) | | `$between` | between `[min, max]` |
| `$gt` / `$gte` | greater than (or equal) | | `$contains` `$startsWith` `$endsWith` | text matching (case-insensitive) |
| `$exists` | field present/absent | | `$hasAny` / `$hasAll` | array field contains any/all of a list |

(The legacy array style uses the same names without the `$`:
`eq ne lt lte gt gte in nin between contains startsWith endsWith
exists hasAny hasAll`.)

Field paths use dots, and a path crossing an array matches when **any**
element matches — the same intuition as MongoDB:

```js
.where({ 'customer.city': 'Oslo' })        // nested object
.where({ 'assignees.name': 'Ada' })        // any array element
.where({ tags: { $hasAny: ['urgent'] } })  // array field
.where({ $or: [{ status: 'open' }, { priority: 'high' }] })
```

Dates compare by time. If the first `.where()` filters on an indexed
field with an equality or range condition, the planner reads through
that index instead of scanning the whole store. The in-memory filter
still runs afterwards, so results are identical either way — the index
is purely an accelerator. See `.explain()` below.

### Other stages

| Stage | What it does |
| --- | --- |
| `.search(text, fields)` | Case-insensitive substring search across the named fields. |
| `.sortBy(sort)` | Sort. Accepts `'name'`, `'-createdAt'` (leading `-` = descending), a comma list (`'status,-total'`), or `[{ field, direction }]`. |
| `.page(page, pageSize)` | 1-based page. Also sets the `total` reported by `.toResult()`. |
| `.limit(n)` | Keep only the first `n` rows at this point in the pipeline. |
| `.select(...fields)` | Keep only these fields (projection). Dotted paths keep their nesting. |
| `.join(store, spec)` | Join another store (below). |
| `.nest(spec)` | Attach child arrays to each row (below). |
| `.unnest(field, opts?)` | Explode an array field into one row per element. `opts.as` renames the element field; rows with an empty/missing field are dropped unless `opts.keepEmpty`. |
| `.groupBy(field, aggregations)` | Group rows and compute aggregates (below). |
| `.pipe(fn, name?)` | Your own stage: `fn(rows, ctx)` must return an array. |
| `.tap(fn)` | Observe rows at this point without changing them: `fn(rows, stageName)`. |
| `.fromIndex(index, range?)` | Read the base store through a specific index/range (escape hatch that overrides the planner). |
| `.withSignal(signal)` | Attach an `AbortSignal` to cancel the run. |

Joins (IndexedDB has no server-side join, so the library snapshots
each store once and hash-joins in memory — linear, not N+1):

```js
// Attach the single matching person as `owner` (or null):
.join('people', { type: 'lookup', localField: 'ownerId', foreignField: 'id', as: 'owner' })
// foreignField defaults to 'id'; add `many: true` to attach an array instead.

// Merge matching rows (inner: unmatched left rows disappear; left: they stay):
.join('people', { type: 'inner', leftKey: 'ownerId', rightKey: 'id' })
.join('people', { type: 'left',  leftKey: 'ownerId', rightKey: 'id', as: 'owner' })
```

Without `as`, joined fields are merged into the row; with `as`, the
match is attached under that property. A custom `merge(left, right)`
function may be supplied for inner/left joins. Keys may be field-name
strings or `(row) => key` functions.

Nesting child collections:

```js
// Direct children: items carry an orderId pointing at the parent.
.nest({ via: 'direct', children: 'items', parentKey: 'id', childKey: 'orderId', as: 'items' })

// Through a link table: workOrders -> assignments -> people.
.nest({ via: 'link', links: 'assignments', targets: 'people',
        parentKey: 'id', linkParent: 'workOrderId', linkTarget: 'personId',
        targetKey: 'id', as: 'assignees' })
```

Grouping with aggregates:

```js
.groupBy('status', { count: true, revenue: { sum: 'total' }, avgTotal: { avg: 'total' } })
// -> [{ status: 'open', count: 3, revenue: 120, avgTotal: 40 }, ...]
```

Aggregate operations are `sum`, `avg`, `min`, `max` (over a numeric
field) and `count`.

### Inspecting a query

Pipelines are inspectable at every stage — this is the main debugging
tool, so use it before reaching for `console.log` inside your code:

```js
const q = db.from('workOrders').where({ status: 'open' }).sortBy('title');

q.explain();
// { source: { store: 'workOrders', strategy: 'index', index: 'byStatus', field: 'status' },
//   steps: ['source', 'filter', 'sort'] }        // strategy is 'full-scan' when no index applies

await q.tap((rows, stage) => console.log(stage, rows.length)).toArray();

const { rows, stages } = await q.runWithStages();
// stages: Map<'source'|'filter'|'sort', rows-at-that-stage>
```

### Terminals

| Terminal | Result |
| --- | --- |
| `.toArray()` | Just the rows array. |
| `.toResult()` | `{ rows, total, page, pageSize, pageCount, plan }`. Without a `.page()`/`.limit()` stage, `total` is the full row count. |
| `.first()` | The first matching row, or `undefined`. |
| `.count()` | How many rows match. A trailing `.page()`/`.limit()` is ignored for the count. |
| `.toMap(key?)` | Results as `Map<key, row>`. Key is a field name or `(row) => key`; defaults to the store's keyPath. |
| `.stream()` | Async iterator over matching rows, one at a time. Intended for filter/search pipelines — joins, nesting, grouping, sorting, projection, and paging need whole arrays and are rejected with code `STREAM_UNSUPPORTED`; use `.toArray()` for those. |

```js
for await (const order of db.from('orders').where({ status: 'open' }).stream()) {
  // row at a time, filtered as it streams
}
```

---

## Live queries and change events

### The change bus

Every write announces itself on the database. Subscribe with
`db.on(...)`; the return value unsubscribes:

```js
const off = db.on('change', (event) => {
  const { store, type, key, record } = event.detail;
  console.log(store, type, key);
});
off(); // stop listening
```

Change detail shape: `{ store, type, key?, record?, keys? }`, with
`type` one of `put | add | delete | clear | bulk`. Bulk writes
(`putAll`, committed multi-write transactions) use `type: 'bulk'` with
a `keys` array; a committed transaction's bulk event also carries
`changes`, the individual writes it collapsed.

Two companion channels exist on the same bus (`db.events`, an
`EventTarget`, for DOM-style listeners): each change is also emitted
as `idb3:change` and as `change:<storeName>`, so a web component can
listen without importing library code.

### `liveQuery(run, stores)`

A live query re-runs a query function whenever one of the listed
stores changes — in this tab, in another tab, or via the sync worker:

```js
const live = db.liveQuery(
  () => db.from('orders').where({ status: 'open' }).toArray(),
  ['orders'],
);

const stop = live.subscribe((rows) => { grid.data = rows; });
// later, when the view goes away:
stop();
live.dispose();
```

- `run` is any (async) function returning the data you want; it runs
  once immediately and again after each relevant change.
- `stores` filters which changes trigger a re-run. Pass `[]` (or omit
  the filtering intent) to refresh on a change to **any** store.
- The returned object exposes `.current` (the latest result, once
  computed), `.refresh()` (re-run now), `.subscribe(fn)` (returns an
  unsubscribe function; a new subscriber is immediately called with
  the current value if one exists), and `.dispose()` (detach
  everything).
- Overlapping refreshes are not queued or cancelled by the library:
  if changes arrive rapidly, several runs may be in flight and the
  last one to finish wins. Keep `run` cheap and idempotent — the
  pipeline terminals above are designed for exactly this.

Sources that trigger a refresh are deliberately uniform: an ordinary
write in this tab, a committed `db.tx()` transaction in this tab
(after commit, never on abort — see
[Transactions](#transactions-across-stores)), a write in another
tab, and a server pull applied by the sync worker. From the
subscriber's point of view they are indistinguishable, which is the
point: the UI simply re-renders with fresh data.

---

## Cross-tab updates

Two tabs open on the same app, both connected to the same database,
keep each other's live queries fresh automatically. No setup, no
worker, no polling:

1. Tab A writes. The write broadcasts a small notification
   (`{ store, type, key }`) on `BroadcastChannel('idb3:<dbName>')`.
   Only the notification crosses — the data itself is already shared,
   because both tabs read the same IndexedDB database.
2. Tab B, which installed a listener for that channel when its
   database was opened, re-emits the message locally as a
   `remote-change` event.
3. Tab B's live queries (and live grid bindings) hear
   `remote-change` and refresh.

Details worth knowing:

- **Ordinary initialization is enough.** Opening the database with
  `ibOpenDatabase()` installs the listener. The sync worker is not
  involved; when a worker *is* used, its broadcasts arrive through
  the same path.
- Listen directly if you only need the signal:
  `db.on('remote-change', (e) => ...)` — `e.detail` is the other
  tab's change object.
- A tab never receives its own broadcast back as a `remote-change`
  (each connection tags its messages with a unique sender id, and
  its listener ignores its own tag). It still hears its own writes
  once, as the ordinary local `change`.
- `broadcast: false` at open time opts the connection out entirely:
  it neither announces its writes nor hears other tabs.
- `db.close()` stops the listener. So does a `versionchange` close
  (when another tab upgrades the schema, this library closes
  politely so the upgrade is not blocked, and emits `versionchange`
  on `db.events`).
- Where `BroadcastChannel` is unavailable, cross-tab notification is
  silently skipped; everything else, including local `change` events,
  works unchanged.
- The low-level helpers are exported if you ever need them outside a
  Database: `ibListenRemoteChanges(dbName, onChange, { sourceId })`
  (returns a stop function) and
  `ibBroadcastChange(dbName, change, sourceId?)`.

---

## Data grids and data-request components

Web Awesome's `<wa-data-grid>` in server mode emits a `wa-data-request`
event whose detail looks like
`{ sort: [{ id, desc }], filters: [{ id, value }], search, page, pageSize, signal }`
with a **0-based** page. The grid adapter serves those requests from
IndexedDB. Other components emitting a similar detail shape can use
the same functions.

### Way A: event binding (one line)

```js
import { ibBindDataGrid } from './IddyBiddyDB/IB_index.js';

const unbind = ibBindDataGrid(grid, db, {
  baseStore: 'workOrders',
  searchFields: ['title', 'status'],
  filterTypes: { total: 'number-range', tags: 'includes-any' },
}, { live: true });
// when the page/component goes away: unbind();
```

`ibBindDataGrid` listens for `wa-data-request`, runs the query, and
sets `grid.loading`, `grid.data`, and `grid.total` for you. It honours
the request's `AbortSignal` (a superseded request that aborts is
ignored quietly; other failures go to the optional `onError` callback
and are re-emitted on the grid as `idb3:error`). With `{ live: true }`
it also re-runs the last request whenever the base store — or any
joined/nested store — changes locally or in another tab.

### Way B: callback data source

```js
import { ibCreateDataSource } from './IddyBiddyDB/IB_index.js';

grid.dataSource = ibCreateDataSource(db, config);
// the grid calls it and uses the returned { rows, total }
```

### The config object

| Key | Meaning |
| --- | --- |
| `baseStore` (alias `store`) | The store to query. |
| `joins` | `[{ store, type, leftKey, rightKey, merge, as }]` — same specs as pipeline `.join()`. |
| `nest` | A pipeline `.nest()` spec (direct or via-link). |
| `searchFields` | Fields the request's `search` text is matched against. |
| `filterTypes` | Per-field translation of column filter values: `equals`, `number-range`, `date-range`, `set`, `includes-any`, `includes-all`. |
| `rangeFields` | Fields whose `[a, b]` filter value means a range rather than a list. |
| `pageBase` | `0` (Web Awesome default) or `1` for legacy callers. Requests are converted to the pipeline's 1-based paging internally. |
| `binaryStores` | `{ storeName: { binary, codec } }` for stores that need decoding after read (see [Codecs](#optional-binary-stores-codecs)). |

Without a `filterTypes` entry, a string filter value becomes a
substring match, an array becomes an `in` list (or a `between` range
for `rangeFields`), and anything else becomes an equality test.
Already-normalized legacy conditions (`{ field, op, value }`) pass
through untouched.

### Lower-level entry points

| Function | Use |
| --- | --- |
| `ibQueryStore(db, config, detail)` | Run one request; returns `{ rows, total, page, pageSize, pageCount, plan }`. |
| `ibCreateDataRequestHandler(db, config)` | A `(detail) => Promise<result>` handler for any component emitting this shape. |
| `ibFetchFromIDB3(detail, config)` | Fetch-shaped wrapper: the returned object has `.ok`, `.status`, and `.json()` resolving to `{ rows, total }`. Put the database on `config.db` for this one. |
| `ibNormalizeGridRequest(detail, config)` | Just the translation step: grid detail → `{ conditions, sort, search, page, pageSize, signal }`. Useful in tests. |

See `IB_demo-grid.js` for a complete worked example, including
nesting assignees onto each row.

---

## Sync: IndexedDB as a cache for your server

The sync layer puts IndexedDB between your UI and your server API.
Reads hit the local store instantly. Writes land locally first, queue
in an `outbox` store, and flush to the server when you say so. The
engine knows nothing about your backend beyond three functions —
bring your own (any REST, GraphQL, or RPC client), or describe a
REST API and let `ibFetchSyncAdapter()` build them.

### Prerequisites

Your database needs the two infrastructure stores (include them in
`stores` when you open the database):

```js
stores: {
  // ... your own stores ...
  outbox: { keyPath: 'seq', autoIncrement: true },   // queued mutations
  meta: 'key',                                       // sync bookkeeping ('syncSeq')
}
```

Conventions: deletes travel as tombstones (records with
`_deleted: true`), and the last-seen server sequence is remembered in
`meta` under the key `'syncSeq'` so a later pull only asks for what
changed since.

### Creating an engine

```js
import { ibCreateSyncEngine, ibFetchSyncAdapter } from './IddyBiddyDB/IB_index.js';

// (a) Describe a REST API as data:
const sync = ibCreateSyncEngine(db, ibFetchSyncAdapter({
  baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push',
  headers: () => ({ Authorization: `Bearer ${token()}` }),  // object, or a function so tokens stay fresh
}));

// (b) ...or hand-write the functions for ANY backend:
const sync2 = ibCreateSyncEngine(db, {
  pull: async (since) => myApi.pullChanges(since),  // -> { changes: [{ store, record }], seq }
  push: async (batch) => myApi.pushChanges(batch),  // throw to keep entries queued for retry
  resolve: 'last-write-wins',
});
```

The expected server shapes for the REST adapter are:

- **Pull:** `GET {baseUrl}{pullPath}?since={seq}` returning
  `{ changes: [{ store, record }], seq }`.
- **Push:** `POST {baseUrl}{pushPath}` with a JSON batch as the body;
  any 2xx counts as delivered.

Adapt odd payloads with the adapter's `parsePull` / `parsePush`
options, or a custom `fetchFn`. Hand-written `pull`/`push` are
called as `pull(since, { db })` / `push(batch, { db })` if you need
the database inside them.

Engine options: `pull`, `push`, optional `pushOne` / `pullOne`,
`resolve` (conflict strategy, below), `retries` (default `2`), and
`backoffMs` (default `500`, doubling per retry).

### Using the engine

| Method | What it does |
| --- | --- |
| `sync.pull()` | Server → local. Applies every change since the remembered sequence, then stores the new sequence. Emits `pulled`. |
| `sync.push()` | Local outbox → server, with retry and backoff. Entries that fail stay queued. Emits `pushed`, or `push-failed` before rethrowing. |
| `sync.sync()` | Pull, then push. Returns `{ pulled, pushed }`. Emits `synced`. |
| `sync.syncOne(store, key)` | Push **just one record** right now — the granular path for a save button or a grid row edit. Reads the current local record, delivers a single-entry batch, and drops any queued entry for that key. Emits `synced-one`. |
| `sync.pullOne(store, key)` | Refresh just one record. Needs a `pullOne` function; without one it falls back to a full `pull()`. Emits `pulled-one`. |
| `sync.mutate(store, op, record)` | Offline-first edit in one call: writes the record locally (`op: 'delete'` deletes; anything else puts) **and** queues the mutation. Returns `{ queued: true, store, key }`. |
| `sync.startAuto(opts?)` / `sync.stopAuto()` | Auto mode (below). |

The everyday offline-first flow is simply:

```js
await sync.pull();                                // server -> local (e.g. at startup)
await db.table('orders').put(order);              // local write: instant UI
await sync.syncOne('orders', order.id);           // push just this record, now
// ...or queue edits and flush them later:
await sync.mutate('orders', 'put', order);        // local write + queued
await sync.push();                                // flush the whole outbox
```

`sync.on(type, fn)` subscribes to engine events (`pulled`,
`pushed`, `synced`, `synced-one`, `pulled-one`, `push-failed`) and
returns an unsubscribe function.

### Auto mode

```js
sync.startAuto({ stores: ['orders'], debounceMs: 800 });
// ... later: sync.stopAuto();
```

Auto mode watches local `change` events (optionally only for the
listed stores), queues each write in the outbox, and pushes after a
debounce. It also pushes when the browser fires `online`. Changes that
the engine itself applied from the server are never re-queued, so
there are no echo loops. A committed multi-write `db.tx()`
transaction arrives as one batched event, and auto mode queues each
of its individual writes.

### Conflicts

When a pull finds a record that also exists locally, the `resolve`
strategy picks the winner:

| Strategy | Winner |
| --- | --- |
| `'last-write-wins'` (default) | Whichever record has the larger `updatedAt`. |
| `'server-wins'` | The remote record. |
| `'client-wins'` | The local record. |
| `'merge'` | The newer record's fields overlaid on the older, per `updatedAt`. |
| `(local, remote) => record` | Your function decides. |

Remote records with `_deleted: true` delete the local record instead
of being stored.

### Outbox primitives (exported for custom flows)

`ibEnqueueMutation(db, mutation)`, `ibPendingMutations(db)`,
`ibPushOutbox(db, deliver)`, `ibPullFromServer(db, pullSince, opts)`
(legacy one-shot pull; prefer the engine), `ibGetMeta(db, key)` /
`ibSetMeta(db, key, value)`, and `ibResolveConflict(local, remote, strategy)`.

---

## Sync in a Web Worker

To keep pulls and pushes off the main thread, run the engine inside
the ready-made worker (`IB_sync-worker.js`) and talk to it through
the main-thread client:

```js
import { ibOpenDatabase, ibCreateSyncWorker } from './IddyBiddyDB/IB_index.js';

const db = await ibOpenDatabase({ name: 'workdb', version: 1, stores: { /* ... */ } });

const worker = ibCreateSyncWorker({
  db,   // your main-thread Database; it already hears worker broadcasts
  init: {
    db:   { name: 'workdb', version: 1, stores: { /* same schema */ } },
    sync: { baseUrl: '/api', pullPath: '/sync/pull', pushPath: '/sync/push' },
  },
});

await worker.sync();                    // pull + push inside the worker
await worker.syncOne('orders', 42);     // flush one record
worker.terminate();
```

- `ibCreateSyncWorker({ workerUrl, init, db })`: `workerUrl` defaults
  to `IB_sync-worker.js` next to the client module; `init` is sent to
  the worker once, and its completion is awaited by later calls.
- Client methods mirror the engine: `pull()`, `push()`, `sync()`,
  `syncOne(store, key)`, `pullOne(store, key)`, plus a low-level
  `call(type, payload)`. `terminate()` ends the worker.
- Functions cannot cross `postMessage`, so the worker's sync is
  described as **data** — the `ibFetchSyncAdapter` spec above. For
  hand-written pull/push logic in a worker, copy `IB_sync-worker.js`
  and edit its engine creation.
- When the worker applies server data it broadcasts on
  `BroadcastChannel('idb3:<dbName>')`. Your main-thread database hears
  that itself as `remote-change` (see
  [Cross-tab updates](#cross-tab-updates)), so live queries and live
  grids refresh with no extra wiring. Passing `db` to the client is
  still accepted; it only adds a forwarding listener for db-like
  objects that do not already listen for themselves.

See `IB_demo-worker.js` for the full pattern.

---

## Optional binary stores (codecs)

By default you do **not** need this section: IndexedDB's structured
clone already stores objects, arrays, `Map`, `Set`, `Date`, `Blob`,
and `ArrayBuffer` values as they are. Use the binary layer only when a
store should persist a compact `Uint8Array` payload instead (wire
dumps, pre-compressed snapshots).

Opt in per call with `{ binary: true }`. The read must use the same
options as the write:

```js
await db.table('snapshots').put(snapshot, { binary: true });
const back = await db.table('snapshots').get(id, { binary: true });
```

- The built-in `json-bytes` codec encodes to UTF-8 JSON bytes and
  round-trips `Map` / `Set` / `Date` (plain `JSON.stringify` would
  lose them).
- `binary` / `codec` options work on `put`, `add`, `putAll`, `get`,
  `getAll`, and `stream` (and through the grid adapter's
  `binaryStores` config).
- Plug in your own codec (e.g. MessagePack) once, then name it:

```js
import { ibRegisterCodec } from './IddyBiddyDB/IB_index.js';

ibRegisterCodec('msgpack', { encode, decode });  // encode(value) -> Uint8Array
await db.table('snapshots').put(snapshot, { binary: true, codec: 'msgpack' });
const back = await db.table('snapshots').get(id, { binary: true, codec: 'msgpack' });
```

`ibRegisterCodec` validates that the codec has `encode`/`decode`
functions and throws a `TypeError` otherwise. Writing with a codec
whose `encode` does not return a `Uint8Array`, or reading a non-bytes
value with `binary: true`, throws an `Error`. `ibGetCodec(name)` and
the raw helpers `ibWrapValue` / `ibUnwrapValue` are exported for
advanced use.

---

## Upgrades, errors, and housekeeping

### Schema upgrades

To change stores or indexes on an existing database, bump `version`
and describe the new shape. The library applies `stores` inside the
version-change transaction, then runs your optional `upgrade`
callback in the same transaction (so data migration and schema
change commit or roll back together):

```js
const db = await ibOpenDatabase({
  name: 'shop',
  version: 2,
  stores: { /* new/changed stores, as before */ },
  upgrade(rawDb, tx, oldVersion, newVersion) {
    // one-off data migrations, using the raw IDB handles
  },
  onBlocked() { showPleaseCloseOtherTabs(); },
});
```

If another tab still holds the old version open, the open is blocked:
this library makes open connections close politely when they see a
`versionchange` (and emits `versionchange` on `db.events`), and the
blocked open rejects with code `BLOCKED` rather than hanging. Close
other tabs and retry.

### Errors

Library errors are `ibIDB3Error` instances (an `Error` subclass) with
a stable, machine-readable `.code`:

| Code | Raised when |
| --- | --- |
| `NO_NAME` | `ibOpenDatabase()` was called without a `name`. |
| `BLOCKED` | An open or delete was blocked by another tab holding an older version. |
| `NO_PIPELINE` | `table.query()` was used without loading the pipeline. Import from `IB_index.js` (or `IB_pipeline.js`). |
| `BAD_INPUT` | `putAll()` received something that is not an Array, Map, iterable, or single record. |
| `BAD_STAGE` | A pipeline `.pipe()` stage did not return an array. |
| `STREAM_UNSUPPORTED` | `.stream()` was asked to run a whole-array stage (join/nest/group/sort/project/page/limit). |
| `TX_ABORTED` | A transaction aborted (via the exported `ibTxDone(tx)` helper). |

Request failures and aborts from IndexedDB itself (constraint
violations, quota, ...) propagate as the native error, unchanged.

Cancellation uses the platform convention: reads and queries taking a
`signal` reject with an `AbortError` (`DOMException`) when the signal
aborts — the same shape `fetch()` produces — so shared abort handling
keeps working.

### Housekeeping

- `ibListDatabases()` — this origin's databases (IndexedDB 3), or
  `[]` where `indexedDB.databases()` is unsupported.
- `ibDeleteDatabase(name)` — delete a database; rejects with
  `BLOCKED` while a tab holds it open.
- `db.close()` — stop the cross-tab listener and close the
  connection.
- `db.raw` — the raw `IDBDatabase`, for anything the shim does not
  cover. The exported `ibTxDone(tx)` and `ibReqToPromise(request, signal?)`
  helpers are handy when you drop to raw requests yourself.

---

## Pure helpers (no database needed)

The engine behind the pipeline works on any array of records, which
makes it handy in unit tests and for non-database data. All of these
are exported from `IB_index.js`:

| Area | Helpers |
| --- | --- |
| Filter / search | `ibApplyFilters(rows, filters, signal?)`, `ibNormalizeFilters`, `ibMatches`, `ibApplySearch(rows, text, fields)`, `ibOPS`, `ibFieldPath`, `ibFieldValues` |
| Sort / page / shape | `ibApplySort`, `ibNormalizeSort`, `ibPaginate(rows, page, pageSize)` (1-based), `ibProject(rows, { pick \| omit })` |
| Group / aggregate | `ibGroupRows`, `ibAggregateBy`, `ibAggregate`, `ibDistinct` |
| Index planning | `ibKeyRangeFor(filters, field)` — build the `IDBKeyRange` a filter implies, or `null` |
| Joins | `ibHashIndex`, `ibInnerJoin`, `ibLeftJoin`, `ibLookup`, `ibMaterializeNest`, `ibNestViaLink`, `ibUnnest` — same semantics and specs as the pipeline `.join()` / `.nest()` / `.unnest()` stages |
| Input handling | `ibToEntries(input, keyPath)` (the `putAll` input normalizer), `ibApplyPatch(record, patch)` (the `update()` patch applier, including dotted paths) |

These functions are pure: they take arrays (and, where relevant,
return new arrays) and never touch IndexedDB, so they run happily in
Node.

---

## Examples and demos

Small, runnable starting points ship with the library. Serve the
folder over HTTP and adapt them into a page (or paste the pieces into
your app):

| File | Shows |
| --- | --- |
| `IB_demo-basic.js` | The everyday tour: opening, seeding, single-record updates, pipeline queries, Maps, transactions, live queries, and sync setup. |
| `IB_demo-grid.js` | A `<wa-data-grid>` served from IndexedDB both ways (event binding and data-source callback), with link-nesting. |
| `IB_demo-worker.js` | Sync in a Web Worker with a live grid refreshing on worker-delivered data. |
| `IB_schemas.js` | A worked example schema (work orders, people, assignments, sync stores) plus seed data: `ibWorkOrderStores`, `ibWorkOrderSchemas`, `ibDefineStore`, `ibSeedWorkOrder`. |

---

## Troubleshooting

**My live query does not refresh after a write.**
Check, in order: the write's store is in the live query's `stores`
list (or the list is empty, meaning "any store"); the subscription is
still active (`dispose()` was not called); the write actually
committed — an aborted `db.tx()` correctly publishes nothing; and, for
cross-tab refreshes, both tabs opened the same database name on the
same origin with `broadcast` enabled.

**My live query refreshes twice for one write.**
One local write produces exactly one local `change`. A second refresh
usually means a second subscription (e.g. a grid bound with
`{ live: true }` *and* a manual `liveQuery` on the same data), or two
Database connections to the same database in one page. A tab never
counts its own broadcast as a `remote-change`.

**Writes inside `db.tx()` seem to do nothing / throw "inactive".**
The callback awaited something that is not an IndexedDB request
(`fetch`, a timer, ...), so the transaction auto-committed before the
next write. Do that work before calling `db.tx()`. Also make sure you
are writing through `tx.table(...)`, not `db.table(...)` — the latter
uses a different transaction entirely.

**Opening the database is blocked.**
Another tab holds an older schema version. The blocked open rejects
with code `BLOCKED` and calls `onBlocked` if you provided one. Close
the other tabs and retry; connections from this library close
politely on `versionchange` to make upgrades possible.

**My query is a full scan.**
Run `.explain()`. The planner only uses an index when the **first**
stage is a `.where()` containing an equality or range condition on a
field that has an index with exactly that keyPath. Declare the index
in `stores` at open time, or force a read with
`.fromIndex(index, range)`. Results are the same either way — only
speed differs.

**Grid pages are off by one.**
That is expected at the boundary: Web Awesome requests are 0-based,
the pipeline is 1-based, and the grid adapter converts between them
(`pageBase` controls the assumption). Do not convert twice.

**`update()` returned `undefined`.**
The key does not exist and `upsert: true` was not passed. That is a
deliberate no-op, not an error.

**Records come back without my `Map`/`Set`/`Date`.**
They should survive — structured clone stores them natively in the
default (non-binary) mode. If you used `{ binary: true }`, make sure
the read uses `{ binary: true }` (and the same `codec`) too; and note
that plain JSON columns on a *server* will not preserve these types —
that is a server-serialization concern, not IndexedDB's.

---

## API quick reference

### Entry points (`IB_index.js`)

| Import | Kind |
| --- | --- |
| `ibOpenDatabase`, `ibListDatabases`, `ibDeleteDatabase`, `ibDatabase` | Open/manage databases |
| `ibTable` | One-store handle (usually via `db.table(name)`) |
| `ibQuery` | Pipeline query (usually via `db.from(name)`) |
| `ibCreateSyncEngine`, `ibSyncEngine`, `ibFetchSyncAdapter` | Server sync |
| `ibCreateSyncWorker`, `ibSyncWorkerClient` | Worker sync |
| `ibBindDataGrid`, `ibCreateDataSource`, `ibCreateDataRequestHandler`, `ibFetchFromIDB3`, `ibQueryStore`, `ibNormalizeGridRequest` | Grid / data-request adapter |
| `ibRegisterCodec`, `ibGetCodec`, `ibJsonBytesCodec`, `ibWrapValue`, `ibUnwrapValue` | Binary codecs |
| `ibChangeBus`, `ibListenRemoteChanges`, `ibBroadcastChange` | Change bus / cross-tab primitives |
| `ibResolveConflict`, `ibEnqueueMutation`, `ibPendingMutations`, `ibPushOutbox`, `ibPullFromServer`, `ibGetMeta`, `ibSetMeta` | Sync primitives |
| `ibWorkOrderStores`, `ibWorkOrderSchemas`, `ibDefineStore`, `ibSeedWorkOrder` | Example schema + seed |
| `ibIDB3Error`, `ibAbortError`, `ibTxDone`, `ibReqToPromise`, `ibNormalizeStores`, `ibGetAllRecords`, `ibPutAllRecords`, `ibTableReadAll` | Errors, raw helpers, legacy free functions |
| Pure helpers | See [Pure helpers](#pure-helpers-no-database-needed) |

### Files

| File | What it is |
| --- | --- |
| `IB_index.js` | Public entry point — import from here |
| `IB_db.js` | Open/upgrade, `ibDatabase`, transactions, durability |
| `IB_table.js` | One-store handle: CRUD, `update()`, Maps, streaming |
| `IB_pipeline.js` | Fluent `ibQuery`: stages, `tap` / `explain` / `runWithStages` |
| `IB_query.js` | Pure filter/search/sort/group/aggregate engine + index planner |
| `IB_join.js` | Hash joins, lookup, nesting, unnest |
| `IB_grid-adapter.js` | `wa-data-grid` / generic data-request wiring |
| `IB_sync.js` | `ibSyncEngine`, outbox, conflicts, REST adapter |
| `IB_sync-worker.js` / `IB_worker-client.js` | Worker sync + main-thread client |
| `IB_codecs.js` | Optional binary encoding (Map/Set/Date-aware JSON) |
| `IB_events.js` | Change bus + cross-tab BroadcastChannel |
| `IB_schemas.js`, `IB_demo-*.js` | Examples: work-orders schema, grid/basic/worker demos |
| `tests/` | Node logic tests + a real-IndexedDB browser test page |

---

## Testing

- **Logic tests (Node):** `npm test` (runs `node --test tests/`).
  These pin the pure layers — query engine, joins, codecs, conflict
  rules, pipeline planning, and the change-notification behaviour
  covered in this manual — and need no browser or database.
- **Integration test (browser):** serve this folder over HTTP and
  open `tests/IB_browser-test.html`. It runs against a real
  IndexedDB engine (CRUD, indexes, transactions and their live-query
  notification, sync, grid queries, and cross-tab refresh without a
  worker) and reports `IddyBiddyDB PASS`/`FAIL` in the page title
  and body.
