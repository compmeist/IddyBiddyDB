// IB_join.js — combining stores in memory. IndexedDB has no server-side join,
// so we snapshot each store once (one short readonly transaction each) and
// hash-join: build a Map on the join key, then walk the left side once.
// That is O(left + right) instead of the N+1 reads juniors often write first.
//
// Key arguments accept a field-name string ('personId') or a function.

import { ibFieldPath } from './IB_query.js';

const asKeyFn = (key) => (typeof key === 'function' ? key : (row) => ibFieldPath(row, key));

export function ibHashIndex(rows, keyFn) {
  const fn = asKeyFn(keyFn);
  const map = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/** Inner join: keep left rows matching at least one right row. */
export function ibInnerJoin(leftRows, rightRows, { leftKey, rightKey, merge, as } = {}) {
  const rightByKey = ibHashIndex(rightRows, rightKey);
  const lk = asKeyFn(leftKey);
  const out = [];
  for (const left of leftRows) {
    for (const right of rightByKey.get(lk(left)) ?? []) {
      out.push(merge ? merge(left, right) : as ? { ...left, [as]: right } : { ...left, ...right });
    }
  }
  return out;
}

/** Left join: always emit the left row; unmatched right side is null. */
export function ibLeftJoin(leftRows, rightRows, { leftKey, rightKey, merge, as } = {}) {
  const rightByKey = ibHashIndex(rightRows, rightKey);
  const lk = asKeyFn(leftKey);
  const out = [];
  for (const left of leftRows) {
    const matches = rightByKey.get(lk(left)) ?? [null];
    for (const right of matches) {
      out.push(merge ? merge(left, right) : as ? { ...left, [as]: right } : right ? { ...left, ...right } : { ...left });
    }
  }
  return out;
}

/**
 * SQL-style named lookup (Mongo $lookup flavour):
 *   ibLookup(orders, people, { localField: 'customerId', foreignField: 'id', as: 'customer', many: false })
 * many:false attaches the single match (or null); many:true attaches an array.
 */
export function ibLookup(leftRows, rightRows, { localField, foreignField = 'id', as, many = false } = {}) {
  const rightByKey = ibHashIndex(rightRows, foreignField);
  return leftRows.map((left) => {
    const matches = rightByKey.get(ibFieldPath(left, localField)) ?? [];
    return { ...left, [as]: many ? [...matches] : (matches[0] ?? null) };
  });
}

/** One-to-many nesting: attach a children array to each parent copy. */
export function ibMaterializeNest(parents, children, { parentKey, childKey, as } = {}) {
  const kidsByParent = ibHashIndex(children, childKey);
  const pk = asKeyFn(parentKey);
  return parents.map((parent) => ({ ...parent, [as]: [...(kidsByParent.get(pk(parent)) ?? [])] }));
}

/** Two-hop nest through a link table: workOrders -> assignments -> people. */
export function ibNestViaLink(parents, links, targets, { parentKey, linkParent, linkTarget, targetKey, as } = {}) {
  const targetsByKey = new Map(targets.map((t) => [asKeyFn(targetKey)(t), t]));
  const kidsByParent = new Map(parents.map((p) => [asKeyFn(parentKey)(p), []]));
  for (const link of links) {
    const bucket = kidsByParent.get(asKeyFn(linkParent)(link));
    const target = targetsByKey.get(asKeyFn(linkTarget)(link));
    if (bucket && target) bucket.push(target);
  }
  return parents.map((parent) => ({ ...parent, [as]: kidsByParent.get(asKeyFn(parentKey)(parent)) ?? [] }));
}

/**
 * Explode an array field into one row per element (SQL UNNEST / Mongo $unwind).
 *   ibUnnest(orders, 'items', { as: 'item' })  // order with 3 items -> 3 rows
 * Rows whose field is empty/missing are dropped unless { keepEmpty: true }.
 */
export function ibUnnest(rows, field, { as = field, keepEmpty = false } = {}) {
  const out = [];
  for (const row of rows) {
    const values = ibFieldPath(row, field);
    if (Array.isArray(values) && values.length) {
      for (const value of values) out.push({ ...row, [as]: value });
    } else if (keepEmpty) out.push({ ...row, [as]: null });
  }
  return out;
}
