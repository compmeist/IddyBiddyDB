// Durable tests for the pure (database-free) layers: query engine, joins,
// pipeline planning/stages, codecs, Maps input, patches, conflict rules and
// the Web Awesome request translator. Run: node --test tests/
// IDB-backed behaviour (Table/Database against a real engine) belongs in a
// browser test page; these tests pin the logic that must never regress.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ibApplyFilters, ibApplySort, ibApplySearch, ibPaginate, ibAggregateBy, ibDistinct, ibNormalizeFilters, ibMatches } from '../IB_query.js';
import { ibInnerJoin, ibLeftJoin, ibLookup, ibMaterializeNest, ibNestViaLink, ibUnnest, ibHashIndex } from '../IB_join.js';
import { ibJsonBytesCodec, ibWrapValue, ibUnwrapValue } from '../IB_codecs.js';
import { ibResolveConflict } from '../IB_sync.js';
import { ibNormalizeGridRequest } from '../IB_grid-adapter.js';
import { ibToEntries, ibApplyPatch } from '../IB_table.js';
import { ibQuery } from '../IB_pipeline.js';

const orders = [
  { id: 1, status: 'open', total: 120, title: 'Fix pump', tags: ['urgent'], customer: { city: 'Oslo' }, assignees: [{ name: 'Ada' }, { name: 'Bo' }] },
  { id: 2, status: 'done', total: 40, title: 'Paint wall', tags: [], customer: { city: 'Bergen' }, assignees: [{ name: 'Cy' }] },
  { id: 3, status: 'open', total: 300, title: 'Pump audit', tags: ['audit', 'urgent'], customer: { city: 'Oslo' }, assignees: [] },
];

test('mongo-style filters: equality, range, $in, dotted + array paths, $or', () => {
  assert.equal(ibApplyFilters(orders, { status: 'open' }).length, 2);
  assert.equal(ibApplyFilters(orders, { total: { $gte: 100, $lt: 200 } }).length, 1);
  assert.equal(ibApplyFilters(orders, { status: { $in: ['done'] } }).length, 1);
  assert.equal(ibApplyFilters(orders, { 'customer.city': 'Oslo' }).length, 2);
  assert.equal(ibApplyFilters(orders, { 'assignees.name': 'Ada' }).length, 1);
  assert.equal(ibApplyFilters(orders, { tags: { $hasAny: ['urgent'] } }).length, 2);
  assert.equal(ibApplyFilters(orders, { $or: [{ status: 'done' }, { total: { $gt: 250 } }] }).length, 2);
  assert.equal(ibApplyFilters(orders, [{ field: 'status', op: 'eq', value: 'open' }]).length, 2); // legacy form
  assert.equal(ibMatches(orders[0], ibNormalizeFilters({ total: { $between: [100, 150] } })), true);
});

test('search + sort + paginate (1-based) compose', () => {
  assert.equal(ibApplySearch(orders, 'pump', ['title']).length, 2);
  assert.deepEqual(ibApplySort(orders, '-total').map((r) => r.id), [3, 1, 2]);
  assert.deepEqual(ibApplySort(orders, 'title').map((r) => r.id), [1, 2, 3]);
  const page = ibPaginate(orders, 2, 2);
  assert.equal(page.total, 3); assert.equal(page.rows.length, 1); assert.equal(page.pageCount, 2);
});

test('group/aggregate/distinct (SQL subset)', () => {
  const byStatus = ibAggregateBy(orders, 'status', { count: true, revenue: { sum: 'total' } });
  assert.deepEqual(byStatus.find((r) => r.status === 'open'), { status: 'open', count: 2, revenue: 420 });
  assert.deepEqual(ibDistinct(orders, 'customer.city'), ['Oslo', 'Bergen']);
});

test('joins: inner/left/lookup/nest/link-nest/unnest', () => {
  const people = [{ id: 'P-1', name: 'Ada' }, { id: 'P-2', name: 'Bo' }];
  const links = [{ workOrderId: 1, personId: 'P-1' }, { workOrderId: 1, personId: 'P-2' }];
  assert.equal(ibInnerJoin([{ ownerId: 'P-1' }, { ownerId: 'PX' }], people, { leftKey: 'ownerId', rightKey: 'id' }).length, 1);
  assert.equal(ibLeftJoin([{ ownerId: 'PX' }], people, { leftKey: 'ownerId', rightKey: 'id', as: 'owner' })[0].owner, null);
  assert.equal(ibLookup([{ ownerId: 'P-2' }], people, { localField: 'ownerId', as: 'owner' })[0].owner.name, 'Bo');
  assert.equal(ibMaterializeNest([{ id: 1 }], links, { parentKey: 'id', childKey: 'workOrderId', as: 'links' })[0].links.length, 2);
  assert.deepEqual(ibNestViaLink(orders.slice(0, 1), links, people,
    { parentKey: 'id', linkParent: 'workOrderId', linkTarget: 'personId', targetKey: 'id', as: 'assignees' })[0].assignees.map((p) => p.name), ['Ada', 'Bo']);
  assert.equal(ibUnnest(orders, 'tags', { as: 'tag' }).length, 3);
  assert.equal(ibHashIndex(people, 'id').get('P-1').length, 1);
});

test('codec round-trips Map/Set/Date inside records', () => {
  const value = { id: 1, lookup: new Map([['a', 1]]), seen: new Set([1, 2]), at: new Date('2026-01-04T00:00:00Z') };
  const back = ibUnwrapValue(ibWrapValue(value, { binary: true }), { binary: true });
  assert.equal(back.lookup.get('a'), 1);
  assert.deepEqual([...back.seen], [1, 2]);
  assert.equal(back.at.getTime(), value.at.getTime());
  assert.equal(ibJsonBytesCodec.decode(ibJsonBytesCodec.encode(value)).id, 1);
});

test('conflict strategies', () => {
  const local = { id: 1, updatedAt: 10, v: 'local' };
  const remote = { id: 1, updatedAt: 20, v: 'remote' };
  assert.equal(ibResolveConflict(local, remote).v, 'remote');
  assert.equal(ibResolveConflict(local, remote, 'client-wins').v, 'local');
  assert.equal(ibResolveConflict(local, remote, 'server-wins').v, 'remote');
  assert.equal(ibResolveConflict(local, remote, (l, r) => ({ ...l, ...r, v: 'merged' })).v, 'merged');
});

test('table input normalization: Array | Map | iterable | single record; deep patch', () => {
  assert.equal(ibToEntries([{ id: 1 }], 'id').length, 1);
  assert.deepEqual(ibToEntries(new Map([['k', { v: 1 }]]), null), [['k', { v: 1 }]]);
  assert.equal(ibToEntries(new Map([['P-1', { id: 'P-1' }]]), 'id')[0][0], undefined); // keyPath: value wins
  assert.deepEqual(ibApplyPatch({ a: { b: 1 } }, { 'a.b': 2, c: 3 }), { a: { b: 2 }, c: 3 });
});

test('wa-data-grid request translation (0-based page, WA sort/filter shapes)', () => {
  const req = ibNormalizeGridRequest({
    sort: [{ id: 'total', desc: true }],
    filters: [{ id: 'status', value: 'open' }, { id: 'total', value: [50, 200] }],
    search: 'pump', page: 0, pageSize: 10,
  }, { filterTypes: { total: 'number-range' } });
  assert.deepEqual(req.sort, [{ field: 'total', direction: 'desc' }]);
  assert.deepEqual(req.conditions, [
    { field: 'status', op: 'contains', value: 'open' },
    { field: 'total', op: 'between', value: [50, 200] },
  ]);
  assert.equal(req.page, 1); // converted to internal 1-based
  // legacy shape still understood
  const legacy = ibNormalizeGridRequest({ sort: [{ field: 'id', direction: 'asc' }], filters: [{ field: 'id', op: 'eq', value: 1 }], page: 1 }, { pageBase: 1 });
  assert.deepEqual(legacy.conditions, [{ field: 'id', op: 'eq', value: 1 }]);
});

/* ----- pipeline with a stub table (no real IndexedDB needed) ----- */

function stubDB() {
  const stores = {
    workOrders: orders,
    people: [{ id: 'P-1', name: 'Ada' }],
  };
  const makeTable = (name) => ({
    name, keyPath: 'id', db: api,
    getAll: async () => [...(stores[name] ?? [])],
    stream: async function* () { for (const r of stores[name] ?? []) yield r; },
  });
  const api = {
    table: (n) => makeTable(n),
    indexForField: (store, field) => (store === 'workOrders' && field === 'status' ? { name: 'byStatus', keyPath: 'status' } : null),
  };
  return api;
}

test('pipeline: stages run in order, tap sees each stage, index plan is explained', async () => {
  const db = stubDB();
  const table = db.table('workOrders');
  const seen = [];
  const q = new ibQuery(table)
    .where({ status: 'open' })
    .tap((rows, stage) => seen.push([stage, rows.length]))
    .sortBy('-total')
    .page(1, 1);
  // No IDBKeyRange in Node: planner must degrade to full-scan, same results.
  assert.equal(q.explain().source.strategy, 'full-scan');
  const { rows, total } = await q.toResult();
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r.id), [3]);
  assert.deepEqual(seen, [['filter', 2]]); // tap was added after filter only

  const staged = await new ibQuery(table).where({ status: 'open' }).sortBy('id').runWithStages();
  assert.deepEqual([...staged.stages.keys()], ['source', 'filter', 'sort']);
  assert.equal(staged.stages.get('source').length, 3);

  const map = await new ibQuery(table).where({ status: 'open' }).toMap('id');
  assert.equal(map.get(1).title, 'Fix pump');
  assert.equal(await new ibQuery(table).where({ status: 'open' }).count(), 2);
});
