// IB_grid-adapter.js — connect ANY data-request component to IndexedDB.
// Built for Web Awesome Pro <wa-data-grid> in server mode, but the request
// shape is the de-facto standard, so this also serves other grids/modules
// that emit something like { sort, filters, search, page, pageSize, signal }.
//
// Two ways to wire a <wa-data-grid> (server mode disables its client-side
// sorting/filtering/paging; you own the data):
//
//   A) Callback:   grid.dataSource = ibCreateDataSource(db, config);
//                  // grid calls it on sort/filter/search/page changes and
//                  // expects Promise<{ rows, total }>.
//
//   B) Event:      ibBindDataGrid(grid, db, config);
//                  // listens for 'wa-data-request', sets grid.data /
//                  // grid.total / grid.loading for you. Returns unbind().
//
// Web Awesome detail (from the data-grid reference): sort is
// [{ id, desc }], filters is [{ id, value }] where value depends on the
// column's filterType (text substring, [min,max] ranges, checked-value
// sets...), page is 0-BASED, pageSize defaults to 20, and detail.signal
// aborts stale requests. Legacy { field, direction } / 1-based callers are
// still understood — see ibNormalizeGridRequest().

import { ibGetAllRecords } from './IB_db.js';
import { ibInnerJoin, ibLeftJoin, ibMaterializeNest, ibNestViaLink } from './IB_join.js';
import { ibApplyFilters, ibApplySearch, ibApplySort, ibPaginate } from './IB_query.js';
import { ibUnwrapValue } from './IB_codecs.js';

/**
 * Translate a grid request into our internal filter/sort/page form.
 * config.filterTypes: { price: 'number-range', tags: 'includes-any', ... }
 * config.rangeFields: fields whose [a, b] array value means a range.
 * config.pageBase: 0 (Web Awesome default) or 1 (legacy callers).
 */
export function ibNormalizeGridRequest(detail = {}, config = {}) {
  const sort = (detail.sort ?? []).map((s) => ({
    field: s.field ?? s.id ?? s.key ?? s.column,
    direction: (s.direction ?? s.dir ?? (s.desc ? 'desc' : 'asc')) === 'desc' || s.desc === true ? 'desc' : 'asc',
  })).filter((s) => s.field);

  const conditions = [];
  const rawFilters = detail.filters ?? [];
  const list = Array.isArray(rawFilters)
    ? rawFilters
    : Object.entries(rawFilters).map(([id, value]) => ({ id, value }));
  for (const f of list) {
    const field = f.field ?? f.id;
    if (!field) continue;
    // Already-normalized legacy condition { field, op, value } passes through.
    if (f.op) { conditions.push({ field, op: f.op, value: f.value }); continue; }
    const value = f.value;
    if (value === undefined || value === null || value === '') continue;
    const type = config.filterTypes?.[field];
    if (type === 'equals') conditions.push({ field, op: 'eq', value });
    else if (type === 'number-range' || type === 'date-range') conditions.push({ field, op: 'between', value });
    else if (type === 'set') conditions.push({ field, op: 'in', value: Array.isArray(value) ? value : [value] });
    else if (type === 'includes-any') conditions.push({ field, op: 'hasAny', value: Array.isArray(value) ? value : [value] });
    else if (type === 'includes-all') conditions.push({ field, op: 'hasAll', value: Array.isArray(value) ? value : [value] });
    else if (Array.isArray(value)) {
      const isRange = (config.rangeFields ?? []).includes(field) && value.length === 2;
      conditions.push({ field, op: isRange ? 'between' : 'in', value });
    } else if (typeof value === 'string') conditions.push({ field, op: 'contains', value });
    else conditions.push({ field, op: 'eq', value });
  }

  const zeroBased = (config.pageBase ?? 0) === 0;
  const rawPage = detail.page ?? (zeroBased ? 0 : 1);
  return {
    conditions,
    sort,
    search: detail.search ?? detail.searchTerm ?? '',
    page: zeroBased ? rawPage + 1 : Math.max(1, rawPage),
    pageSize: detail.pageSize ?? 20,
    signal: detail.signal,
  };
}

function maybeDecode(rows, storeName, binaryStores) {
  const opts = binaryStores?.[storeName];
  return opts ? rows.map((r) => ibUnwrapValue(r, opts)) : rows;
}

/**
 * Run one grid request. Returns { rows, total, page, pageSize, pageCount, plan }.
 * config: { db?, baseStore|store, joins?, nest?, searchFields?, binaryStores?,
 *           filterTypes?, rangeFields?, pageBase? }
 * (db may live on config for ibFetchFromIDB3-style calls, or be arg 1.)
 */
export async function ibQueryStore(db, config, detail = {}) {
  const cfg = config?.db && !db?.table ? config : { ...config, db: config?.db ?? db };
  const database = cfg.db ?? db;
  const baseStore = cfg.baseStore ?? cfg.store;
  const req = ibNormalizeGridRequest(detail, cfg);

  // Binary stores bypass the pipeline (records need decoding after read).
  if (cfg.binaryStores && Object.keys(cfg.binaryStores).length) {
    return queryStoreBinary(database, cfg, baseStore, req);
  }

  let q = database.from(baseStore);
  for (const j of cfg.joins ?? []) {
    q = q.join(j.store, { type: j.type ?? 'inner', leftKey: j.leftKey, rightKey: j.rightKey, merge: j.merge, as: j.as });
  }
  if (cfg.nest) q = q.nest(cfg.nest);
  if (req.conditions.length) q = q.where(req.conditions);
  if (req.search) q = q.search(req.search, cfg.searchFields ?? []);
  if (req.sort.length) q = q.sortBy(req.sort);
  q = q.page(req.page, req.pageSize);
  if (req.signal) q = q.withSignal(req.signal);
  return q.toResult();
}

async function queryStoreBinary(database, cfg, baseStore, req) {
  const raw = database.raw ?? database;
  const binaryStores = cfg.binaryStores ?? {};
  let rows = maybeDecode(await ibGetAllRecords(raw, baseStore, { signal: req.signal }), baseStore, binaryStores);
  for (const j of cfg.joins ?? []) {
    const right = maybeDecode(await ibGetAllRecords(raw, j.store, { signal: req.signal }), j.store, binaryStores);
    const spec = { leftKey: j.leftKey, rightKey: j.rightKey, merge: j.merge, as: j.as };
    rows = j.type === 'left' ? ibLeftJoin(rows, right, spec) : ibInnerJoin(rows, right, spec);
  }
  if (cfg.nest) {
    const n = cfg.nest;
    rows = n.via === 'link'
      ? ibNestViaLink(rows, maybeDecode(await ibGetAllRecords(raw, n.links, { signal: req.signal }), n.links, binaryStores),
          maybeDecode(await ibGetAllRecords(raw, n.targets, { signal: req.signal }), n.targets, binaryStores), n)
      : ibMaterializeNest(rows, maybeDecode(await ibGetAllRecords(raw, n.children, { signal: req.signal }), n.children, binaryStores), n);
  }
  rows = ibApplyFilters(rows, req.conditions, req.signal);
  rows = ibApplySearch(rows, req.search, cfg.searchFields ?? []);
  rows = ibApplySort(rows, req.sort);
  return ibPaginate(rows, req.page, req.pageSize);
}

/** Response-like wrapper (fetch-shaped): only .ok/.status/.json(). */
export async function ibFetchFromIDB3(detail, config) {
  const { rows, total } = await ibQueryStore(config?.db ?? config, config, detail);
  return { ok: true, status: 200, async json() { return { rows, total }; } };
}

/**
 * Web Awesome way A — assign as grid.dataSource. The grid passes a
 * DataGridRequest { sort, filters, search, page, pageSize, signal } and
 * uses the returned { rows, total } (it manages loading itself).
 */
export function ibCreateDataSource(db, config) {
  return async (request) => {
    const { rows, total } = await ibQueryStore(db, config, request);
    return { rows, total };
  };
}

/** Generic handler for ANY component emitting a data-request-style detail. */
export function ibCreateDataRequestHandler(db, config) {
  return async (detail) => ibQueryStore(db, config, detail);
}

/**
 * Web Awesome way B — wire 'wa-data-request' on a <wa-data-grid server>.
 * Sets grid.loading/data/total, honours detail.signal, and (optionally)
 * refreshes when the underlying stores change locally or in another tab.
 * Returns an unbind function.
 */
export function ibBindDataGrid(grid, db, config, { live = false, onError } = {}) {
  let lastDetail = { page: 0, pageSize: grid.pageSize ?? 20 };
  const run = async (detail) => {
    lastDetail = detail ?? lastDetail;
    grid.loading = true;
    try {
      const { rows, total } = await ibQueryStore(db, config, lastDetail);
      grid.data = rows;
      grid.total = total;
    } catch (err) {
      if (err?.name === 'AbortError') return; // superseded request; grid moved on
      onError?.(err);
      grid.dispatchEvent?.(new CustomEvent('idb3:error', { detail: { error: err }, bubbles: true }));
      throw err;
    } finally {
      grid.loading = false;
    }
  };
  const onRequest = (event) => { void run(event.detail).catch(() => {}); };
  grid.addEventListener('wa-data-request', onRequest);

  let offLive;
  if (live) {
    const stores = new Set([config.baseStore ?? config.store,
      ...(config.joins ?? []).map((j) => j.store),
      config.nest?.links, config.nest?.targets, config.nest?.children].filter(Boolean));
    const refresh = (e) => { if (stores.has(e.detail?.store)) void run().catch(() => {}); };
    const off1 = db.on('change', refresh);
    const off2 = db.on('remote-change', refresh);
    offLive = () => { off1(); off2(); };
  }
  return () => { grid.removeEventListener('wa-data-request', onRequest); offLive?.(); };
}
