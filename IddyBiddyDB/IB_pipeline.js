// IB_pipeline.js — the fluent query pipeline. This is the heart of the library.
//
//   const { rows, total } = await db.from('workOrders')
//     .join('people', { type: 'lookup', localField: 'ownerId', as: 'owner' })
//     .where({ status: 'open', total: { $gte: 100 } })       // Mongo-style
//     .search('pump', ['title'])                              // fuzzy text
//     .sortBy('-createdAt')                                   // newest first
//     .page(1, 20)                                            // 1-based page
//     .toResult();
//
// A query is a PIPELINE of named stages, executed in the order you add them:
//   source -> join/nest -> where -> search -> sort -> group -> project -> page
// Every stage is inspectable — that is what "data at different granularity,
// accessible at each stage" means in practice:
//   .tap((rows, stage) => console.log(stage, rows.length))  // watch it flow
//   const { stages } = await q.runWithStages();             // Map<stage, rows>
//   q.explain()                                             // plan, incl. index use
//
// Terminals: toArray() | toResult() | first() | count() | toMap() | stream()

import { ibTable } from './IB_table.js';
import { ibApplyFilters, ibApplySearch, ibApplySort, ibAggregateBy, ibKeyRangeFor, ibNormalizeFilters, ibNormalizeSort, ibPaginate, ibProject } from './IB_query.js';
import { ibInnerJoin, ibLeftJoin, ibLookup, ibMaterializeNest, ibNestViaLink, ibUnnest } from './IB_join.js';
import { ibIDB3Error, ibThrowIfAborted } from './IB_internal.js';

export class ibQuery {
  constructor(table) {
    this.table = table;
    this.steps = [];       // [{ name, run(rows, ctx) }] in call order
    this._where = null;    // merged filter (also used by the index planner)
    this._signal = null;
    this._sourceSpec = null; // explicit { index, range } override
  }

  /* ----- stage builders (each returns `this` for chaining) ----- */

  /** Filter. Mongo object, legacy array, or (row) => boolean. Repeatable (ANDed). */
  where(filters) {
    this._where = mergeWhere(this._where, filters);
    this.steps.push({ name: 'filter', run: (rows, ctx) => ibApplyFilters(rows, filters, ctx.signal) });
    return this;
  }

  /** Case-insensitive text search across fields. */
  search(text, fields = []) {
    this.steps.push({ name: 'search', run: (rows) => ibApplySearch(rows, text, fields) });
    return this;
  }

  /** Sort: sortBy('name'), sortBy('-createdAt'), sortBy([{field, direction}]). */
  sortBy(sort) {
    const specs = ibNormalizeSort(sort);
    this.steps.push({ name: 'sort', detail: specs, run: (rows) => ibApplySort(rows, specs) });
    return this;
  }

  /**
   * Join another store.
   *   .join('people', { type:'inner'|'left', leftKey:'ownerId', rightKey:'id', merge })
   *   .join('people', { type:'lookup', localField:'ownerId', as:'owner', many:false })
   * Keys accept a field-name string or (row) => key.
   */
  join(store, spec = {}) {
    this.steps.push({
      name: `join:${store}`,
      run: async (rows, ctx) => {
        const right = await ctx.read(store);
        if (spec.type === 'lookup') return ibLookup(rows, right, spec);
        const joinSpec = { leftKey: spec.leftKey, rightKey: spec.rightKey ?? 'id', merge: spec.merge, as: spec.as };
        return spec.type === 'left' ? ibLeftJoin(rows, right, joinSpec) : ibInnerJoin(rows, right, joinSpec);
      },
    });
    return this;
  }

  /**
   * Attach child arrays.
   *   .nest({ via:'direct', children:'items', parentKey:'id', childKey:'orderId', as:'items' })
   *   .nest({ via:'link', links:'assignments', targets:'people', parentKey:'id',
   *           linkParent:'workOrderId', linkTarget:'personId', targetKey:'id', as:'assignees' })
   */
  nest(spec) {
    this.steps.push({
      name: 'nest',
      run: async (rows, ctx) => spec.via === 'link'
        ? ibNestViaLink(rows, await ctx.read(spec.links), await ctx.read(spec.targets), spec)
        : ibMaterializeNest(rows, await ctx.read(spec.children), spec),
    });
    return this;
  }

  /** Explode an array field into one row per element. */
  unnest(field, opts) {
    this.steps.push({ name: 'unnest', run: (rows) => ibUnnest(rows, field, opts) });
    return this;
  }

  /** Group + aggregate: .groupBy('status', { count:true, revenue:{sum:'total'} }) */
  groupBy(field, aggregations) {
    this.steps.push({ name: 'group', run: (rows) => ibAggregateBy(rows, field, aggregations) });
    return this;
  }

  /** Keep only these fields: .select('id', 'title') — dotted paths keep nesting. */
  select(...fields) {
    const list = fields.flat();
    this.steps.push({ name: 'project', run: (rows) => ibProject(rows, { pick: list }) });
    return this;
  }

  /** Your own stage: .pipe((rows) => rows.filter(...), 'onlyMine'). */
  pipe(fn, name = 'custom') {
    this.steps.push({ name, run: (rows, ctx) => fn(rows, ctx) });
    return this;
  }

  /** Observe the stage just before this point: .tap((rows, stage) => ...). */
  tap(fn) {
    this.steps.push({ name: 'tap', isTap: true, run: (rows, ctx) => { fn(rows, ctx.stage); return rows; } });
    return this;
  }

  /** 1-based page. Also sets the `total` reported by toResult(). */
  page(page = 1, pageSize = 20) {
    this.steps.push({
      name: 'paginate',
      run: (rows, ctx) => { const r = ibPaginate(rows, page, pageSize); ctx.total = r.total; ctx.pageInfo = r; return r.rows; },
    });
    return this;
  }

  /** Keep only the first n rows (after whatever came before). */
  limit(n) {
    this.steps.push({ name: 'limit', run: (rows, ctx) => { ctx.total ??= rows.length; return rows.slice(0, Math.max(0, n)); } });
    return this;
  }

  /** Read the base store through a specific index/range (escape hatch). */
  fromIndex(index, range) { this._sourceSpec = { index, range }; return this; }

  /** Attach an AbortSignal (e.g. from wa-data-request) to cancel the run. */
  withSignal(signal) { this._signal = signal; return this; }

  /* ----- planning ----- */

  /**
   * Describe the plan without running it:
   * { source: { store, strategy:'index'|'full-scan', index?, field? }, steps: [names] }
   * The planner accelerates the common case: a first-stage where() on an
   * indexed field with eq/range conditions reads through that index; the
   * in-memory filter still runs, so results are identical either way.
   */
  explain() {
    const plan = this._planSource();
    return { source: plan.description, steps: ['source', ...this.steps.map((s) => s.name)] };
  }

  _planSource() {
    if (this._sourceSpec?.index) return { kind: 'index', ...this._sourceSpec, description: { store: this.table.name, strategy: 'index', index: this._sourceSpec.index } };
    const tree = this._where ? ibNormalizeFilters(this._where) : { all: [] };
    const firstStepIsFilter = this.steps[0]?.name === 'filter';
    if (firstStepIsFilter) {
      for (const cond of tree.all) {
        if (!cond.field || cond.anyOf || cond.all) continue;
        const idx = this.table.db.indexForField(this.table.name, cond.field);
        if (!idx) continue;
        const kr = ibKeyRangeFor(this._where, cond.field);
        if (kr) return { kind: 'index', index: idx.name, range: kr.range, description: { store: this.table.name, strategy: 'index', index: idx.name, field: cond.field } };
        if (cond.op === 'in' && Array.isArray(cond.value)) {
          return { kind: 'index-in', index: idx.name, values: cond.value, description: { store: this.table.name, strategy: 'index', index: idx.name, field: cond.field } };
        }
      }
    }
    return { kind: 'scan', description: { store: this.table.name, strategy: 'full-scan' } };
  }

  async _readSource(ctx) {
    const plan = this._planSource();
    ctx.plan = plan.description;
    if (plan.kind === 'index') return this.table.getAll({ index: plan.index, range: plan.range, signal: ctx.signal });
    if (plan.kind === 'index-in') {
      const parts = await Promise.all(plan.values.map((v) =>
        this.table.getAll({ index: plan.index, range: typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(v) : undefined, signal: ctx.signal })));
      const seen = new Set(); const out = [];
      for (const row of parts.flat()) { const k = row?.[this.table.keyPath]; if (!seen.has(k)) { seen.add(k); out.push(row); } }
      return out;
    }
    if (this._sourceSpec) return this.table.getAll({ ...this._sourceSpec, signal: ctx.signal });
    return this.table.getAll({ signal: ctx.signal });
  }

  /* ----- execution ----- */

  async _execute({ collectStages = false } = {}) {
    ibThrowIfAborted(this._signal);
    const db = this.table.db;
    const ctx = {
      signal: this._signal, total: undefined, pageInfo: undefined, plan: undefined, stage: 'source',
      read: (store) => db.table(store).getAll({ signal: this._signal }),
    };
    const stages = collectStages ? new Map() : null;
    let rows = await this._readSource(ctx);
    if (stages) stages.set('source', [...rows]);
    for (const step of this.steps) {
      ibThrowIfAborted(this._signal);
      if (!step.isTap) ctx.stage = step.name; // tap reports the stage it observes
      rows = await step.run(rows, ctx);
      if (!Array.isArray(rows)) throw new ibIDB3Error(`Pipeline stage "${step.name}" must return an array`, { code: 'BAD_STAGE' });
      if (stages && !step.isTap) stages.set(step.name, [...rows]);
    }
    ctx.total ??= rows.length;
    return { rows, total: ctx.total, pageInfo: ctx.pageInfo, plan: ctx.plan, stages };
  }

  /** Run and get { rows, total, page, pageSize, pageCount, plan }. */
  async toResult() {
    const { rows, total, pageInfo, plan } = await this._execute();
    return { rows, total, page: pageInfo?.page ?? 1, pageSize: pageInfo?.pageSize ?? rows.length, pageCount: pageInfo?.pageCount ?? 1, plan };
  }

  /** Run and get just the rows array. */
  async toArray() { return (await this._execute()).rows; }

  /** Run and also capture every stage's rows: { rows, total, stages: Map<name, rows>, plan }. */
  async runWithStages() { return this._execute({ collectStages: true }); }

  /** First matching row, or undefined. */
  async first() { return (await this.toArray())[0]; }

  /** How many rows match (ignores a trailing page/limit step's slicing). */
  async count() {
    const noPage = this.steps.filter((s) => s.name !== 'paginate' && s.name !== 'limit');
    const clone = new ibQuery(this.table);
    clone.steps = noPage; clone._where = this._where; clone._signal = this._signal; clone._sourceSpec = this._sourceSpec;
    return (await clone._execute()).total;
  }

  /** Results as Map<key, row>. Key from a field name or (row) => key. */
  async toMap(key = undefined) {
    const rows = await this.toArray();
    const keyOf = typeof key === 'function' ? key : (row) => row?.[key ?? this.table.keyPath];
    return new Map(rows.map((row) => [keyOf(row), row]));
  }

  /**
   * Stream base-store rows through filter/search steps one at a time.
   * Join/nest/group steps need whole arrays, so they are rejected here —
   * use toArray() for those. Good for very large stores / progress UIs.
   */
  async *stream() {
    const blocked = this.steps.find((s) => /^(join:|nest|group|sort|project|paginate|limit)/.test(s.name));
    if (blocked) throw new ibIDB3Error(`stream() cannot run stage "${blocked.name}"; use toArray() instead`, { code: 'STREAM_UNSUPPORTED' });
    const plan = this._planSource();
    const sourceOpts = plan.kind === 'index' ? { index: plan.index, range: plan.range } : (this._sourceSpec ?? {});
    for await (const row of this.table.stream({ ...sourceOpts, signal: this._signal })) {
      let rows = [row]; let keep = true;
      for (const step of this.steps) {
        rows = await step.run(rows, { signal: this._signal, stage: step.name });
        if (!rows.length) { keep = false; break; }
      }
      if (keep) yield rows[0];
    }
  }
}

function mergeWhere(prev, next) {
  if (prev == null) return next;
  if (next == null) return prev;
  // AND two filter forms together via the normalized tree's $and wrapper.
  return { $and: [prev, next] };
}

// Register with Table (avoids a static import cycle IB_table.js <-> IB_pipeline.js).
ibTable._queryFactory = (table) => new ibQuery(table);
