// IB_query.js — the in-memory query engine: filter, search, sort, paginate,
// group, aggregate, project. Pure functions over arrays of records, so they
// are unit-testable without a database and reusable on any array/Map values.
//
// Two filter dialects, one engine (use whichever reads better):
//   Mongo-style (recommended):  { status: 'open', total: { $gte: 100 }, $or: [ ... ] }
//   Legacy array style:         [{ field: 'status', op: 'eq', value: 'open' }]
//
// Field paths use dots ('customer.city'). If a path crosses an array
// ('assignees.name'), the filter matches when ANY element matches — the same
// intuition as MongoDB. Dates compare by time; everything else with </>.

/** Read one dotted path. Returns undefined when any hop is missing (nullish-safe). */
export function ibFieldPath(row, path) {
  return String(path).split('.').reduce((acc, part) => acc?.[part], row);
}

/** All values at a dotted path, flattening arrays along the way (for matching). */
export function ibFieldValues(row, path) {
  let nodes = [row];
  for (const part of String(path).split('.')) {
    const next = [];
    for (const node of nodes) {
      if (Array.isArray(node)) for (const el of node) next.push(el?.[part]);
      else next.push(node?.[part]);
    }
    nodes = next;
  }
  return nodes.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

function cmp(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x == null || y == null) return null; // incomparable
  return x < y ? -1 : x > y ? 1 : 0;
}

export const ibOPS = {
  eq: (a, b) => a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()),
  ne: (a, b) => !ibOPS.eq(a, b),
  lt: (a, b) => cmp(a, b) === -1,
  lte: (a, b) => { const c = cmp(a, b); return c !== null && c <= 0; },
  gt: (a, b) => cmp(a, b) === 1,
  gte: (a, b) => { const c = cmp(a, b); return c !== null && c >= 0; },
  in: (a, b) => Array.isArray(b) && b.some((v) => ibOPS.eq(a, v)),
  nin: (a, b) => !ibOPS.in(a, b),
  between: (a, b) => Array.isArray(b) && ibOPS.gte(a, b[0]) && ibOPS.lte(a, b[1]),
  contains: (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().includes(b.toLowerCase()),
  startsWith: (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().startsWith(b.toLowerCase()),
  endsWith: (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().endsWith(b.toLowerCase()),
  exists: (a, b) => (a !== undefined) === Boolean(b),
  hasAny: (a, b) => Array.isArray(a) && Array.isArray(b) && b.some((v) => a.some((x) => ibOPS.eq(x, v))),
  hasAll: (a, b) => Array.isArray(a) && Array.isArray(b) && b.every((v) => a.some((x) => ibOPS.eq(x, v))),
};

const MONGO_OPS = { $eq: 'eq', $ne: 'ne', $lt: 'lt', $lte: 'lte', $gt: 'gt', $gte: 'gte', $in: 'in', $nin: 'nin', $between: 'between', $contains: 'contains', $startsWith: 'startsWith', $endsWith: 'endsWith', $exists: 'exists', $hasAny: 'hasAny', $hasAll: 'hasAll' };

/**
 * Normalize any accepted filter form into [{ field, op, value }] conditions
 * (ANDed), with $and/$or groups preserved as { anyOf: [...] } / nested lists.
 * Returns a predicate-ready tree: { all: [cond|group...] } — see ibMatches().
 */
export function ibNormalizeFilters(filters) {
  if (filters == null) return { all: [] };
  if (Array.isArray(filters)) {
    // Either legacy [{field,op,value}] or a list of Mongo objects.
    const looksLegacy = filters.every((f) => f && typeof f === 'object' && 'field' in f);
    if (looksLegacy) return { all: filters.map((f) => ({ field: f.field, op: f.op ?? 'eq', value: f.value })) };
    return { all: filters.map((f) => ibNormalizeFilters(f)) };
  }
  if (typeof filters === 'object') {
    const all = [];
    for (const [key, value] of Object.entries(filters)) {
      if (key === '$and') all.push(...value.map((f) => ibNormalizeFilters(f)));
      else if (key === '$or') all.push({ anyOf: value.map((f) => ibNormalizeFilters(f)) });
      else if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)
        && Object.keys(value).some((k) => k.startsWith('$'))) {
        for (const [op, v] of Object.entries(value)) all.push({ field: key, op: MONGO_OPS[op] ?? op.replace('$', ''), value: v });
      } else {
        all.push({ field: key, op: 'eq', value });
      }
    }
    return { all };
  }
  return { all: [] };
}

/** Does one row satisfy a normalized filter tree? */
export function ibMatches(row, tree) {
  return (tree?.all ?? []).every((item) => {
    if (item.anyOf) return item.anyOf.some((sub) => ibMatches(row, sub));
    if (item.all) return ibMatches(row, item);
    const op = ibOPS[item.op] ?? ibOPS.eq;
    // hasAny/hasAll judge the array itself; every other op judges its elements.
    if (item.op === 'hasAny' || item.op === 'hasAll') return op(ibFieldPath(row, item.field), item.value);
    // Array-crossing paths: keep the row when ANY reached value satisfies the op.
    return ibFieldValues(row, item.field).some((v) => op(v, item.value));
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw (signal.reason ?? new DOMException('Aborted', 'AbortError'));
}

/** Filter rows. Accepts Mongo object, legacy array, or a predicate function. */
export function ibApplyFilters(rows, filters = [], signal) {
  if (typeof filters === 'function') return rows.filter((r) => { throwIfAborted(signal); return filters(r); });
  const tree = ibNormalizeFilters(filters);
  if (!tree.all.length) return rows;
  return rows.filter((row) => { throwIfAborted(signal); return ibMatches(row, tree); });
}

/** Case-insensitive substring search across the given fields. */
export function ibApplySearch(rows, search = '', fields = []) {
  if (!search || !fields.length) return rows;
  const needle = String(search).toLowerCase();
  return rows.filter((row) => fields.some((f) => ibFieldValues(row, f).some((v) => String(v ?? '').toLowerCase().includes(needle))));
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last, both directions stay readable
  if (b == null) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

/** Normalize sort input: [{field|id, direction|dir|desc}] or 'field' / '-field'. */
export function ibNormalizeSort(sort) {
  if (!sort) return [];
  if (typeof sort === 'string') return sort.split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.startsWith('-') ? { field: s.slice(1), direction: 'desc' } : { field: s, direction: 'asc' });
  const list = Array.isArray(sort) ? sort : [sort];
  return list.map((s) => ({
    field: s.field ?? s.id ?? s.key ?? s.column,
    direction: (s.direction ?? s.dir ?? (s.desc ? 'desc' : 'asc')) === 'desc' || s.desc === true ? 'desc' : 'asc',
  })).filter((s) => s.field);
}

/** Stable multi-field sort. `sort`: [{field, direction}], 'name', or '-createdAt'. */
export function ibApplySort(rows, sort = []) {
  const specs = ibNormalizeSort(sort);
  if (!specs.length) return rows;
  return [...rows].sort((ra, rb) => {
    for (const { field, direction } of specs) {
      const c = compareValues(ibFieldPath(ra, field), ibFieldPath(rb, field));
      if (c !== 0) return direction === 'desc' ? -c : c;
    }
    return 0;
  });
}

/** page is 1-based. Returns { rows, total, page, pageSize, pageCount }. */
export function ibPaginate(rows, page = 1, pageSize = 20) {
  const total = rows.length;
  const size = Math.max(1, pageSize || 20);
  const current = Math.max(1, page || 1);
  const start = (current - 1) * size;
  return { rows: rows.slice(start, start + size), total, page: current, pageSize: size, pageCount: Math.max(1, Math.ceil(total / size)) };
}

/** Keep only (or drop) fields. Paths may be dotted; output keeps nesting. */
export function ibProject(rows, { pick, omit } = {}) {
  return rows.map((row) => {
    if (pick) {
      const out = {};
      for (const path of pick) {
        const value = ibFieldPath(row, path);
        if (value === undefined) continue;
        const parts = path.split('.');
        let node = out;
        for (const p of parts.slice(0, -1)) node = (node[p] ??= {});
        node[parts.at(-1)] = value;
      }
      return out;
    }
    if (omit) {
      const out = structuredClone(row);
      for (const path of omit) {
        const parts = path.split('.');
        let node = out;
        for (const p of parts.slice(0, -1)) node = node?.[p];
        if (node) delete node[parts.at(-1)];
      }
      return out;
    }
    return row;
  });
}

/** Group rows by a field into Map<key, rows>. */
export function ibGroupRows(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = ibFieldPath(row, field);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/**
 * SQL-ish grouping with aggregates:
 *   ibAggregateBy(rows, 'status', { count: true, revenue: { sum: 'total' }, avgTotal: { avg: 'total' } })
 * -> [{ status: 'open', count: 3, revenue: 120, avgTotal: 40 }, ...]
 */
export function ibAggregateBy(rows, field, aggregations = { count: true }) {
  const out = [];
  for (const [key, members] of ibGroupRows(rows, field)) {
    const row = { [field.split('.').at(-1)]: key };
    for (const [alias, spec] of Object.entries(aggregations)) {
      row[alias] = computeAggregate(members, alias === 'count' && spec === true ? { count: true } : spec);
    }
    out.push(row);
  }
  return out;
}

/** Aggregates over one flat list: ibAggregate(rows, { totalRevenue: { sum: 'total' } }). */
export function ibAggregate(rows, aggregations = {}) {
  const out = {};
  for (const [alias, spec] of Object.entries(aggregations)) out[alias] = computeAggregate(rows, spec);
  return out;
}

function computeAggregate(rows, spec) {
  if (spec === true || spec?.count) return rows.length;
  const [op, field] = Object.entries(spec ?? {})[0] ?? [];
  const values = rows.map((r) => ibFieldPath(r, field)).filter((v) => typeof v === 'number');
  switch (op) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    case 'min': return values.length ? Math.min(...values) : null;
    case 'max': return values.length ? Math.max(...values) : null;
    default: return rows.length;
  }
}

/** Distinct values of a field (first-seen order). */
export function ibDistinct(rows, field) {
  return [...new Set(rows.map((r) => ibFieldPath(r, field)))];
}

/* ---------- Index planner: turn simple filters into an IDBKeyRange ---------- */

/**
 * If the filters contain a usable condition on `field`, build the IDBKeyRange
 * for it (eq -> only, gt/gte/lt/lte/between -> bound range). Returns
 * { range, exact:boolean } or null when no fast path applies. The in-memory
 * filter still runs afterwards, so this is purely an accelerator.
 */
export function ibKeyRangeFor(filters, field) {
  const tree = ibNormalizeFilters(filters);
  const conds = tree.all.filter((c) => c.field === field && !c.anyOf && !c.all);
  if (!conds.length || typeof IDBKeyRange === 'undefined') return null;
  let lower; let upper; let lowerOpen = false; let upperOpen = false; let exact;
  for (const c of conds) {
    if (c.op === 'eq') exact = c.value;
    else if (c.op === 'between') { lower = c.value?.[0]; upper = c.value?.[1]; }
    else if (c.op === 'gt') { lower = c.value; lowerOpen = true; }
    else if (c.op === 'gte') lower = c.value;
    else if (c.op === 'lt') { upper = c.value; upperOpen = true; }
    else if (c.op === 'lte') upper = c.value;
    else return null; // contains/in/... -> no single range; caller falls back
  }
  try {
    if (exact !== undefined) return { range: IDBKeyRange.only(exact), exact: true };
    if (lower !== undefined && upper !== undefined) return { range: IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen), exact: false };
    if (lower !== undefined) return { range: IDBKeyRange.lowerBound(lower, lowerOpen), exact: false };
    if (upper !== undefined) return { range: IDBKeyRange.upperBound(upper, upperOpen), exact: false };
  } catch { return null; }
  return null;
}
