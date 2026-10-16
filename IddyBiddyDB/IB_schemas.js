// IB_schemas.js — example store definitions + seed data for the demos/tests.
// A schema says: store name, which property is the key (keyPath), whether
// keys auto-increment, and which indexes to maintain.
//
// Preferred shorthand (used by ibOpenDatabase({ stores })):
//   { workOrders: { keyPath: 'id', indexes: { byStatus: 'status' } } }
// The descriptor-array form below is equivalent and kept for compatibility.

/** Define one store descriptor (array form). Helper for readable schema lists. */
export function ibDefineStore(name, { keyPath = null, autoIncrement = false, indexes = [] } = {}) {
  return {
    name, keyPath, autoIncrement,
    indexes: indexes.map((i) => typeof i === 'string'
      ? { name: i, keyPath: i.replace(/^by/, '').replace(/^./, (c) => c.toLowerCase()), unique: false, multiEntry: false }
      : { name: i.name, keyPath: i.keyPath, unique: Boolean(i.unique), multiEntry: Boolean(i.multiEntry) }),
  };
}

export const ibWorkOrderSchemas = [
  {
    name: 'workOrders',
    keyPath: 'id',
    indexes: [
      { name: 'byStatus', keyPath: 'status', unique: false },
      { name: 'byCreated', keyPath: 'createdAt', unique: false },
    ],
  },
  {
    name: 'people',
    keyPath: 'id',
    indexes: [{ name: 'byName', keyPath: 'name', unique: false }],
  },
  {
    // Join table: one row per (workOrder, person) assignment.
    name: 'assignments',
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: 'byWorkOrder', keyPath: 'workOrderId', unique: false },
      { name: 'byPerson', keyPath: 'personId', unique: false },
    ],
  },
  // Sync infrastructure stores (required when you use IB_sync.js):
  { name: 'outbox', keyPath: 'seq', autoIncrement: true, indexes: [] },
  { name: 'meta', keyPath: 'key', indexes: [] },
];

/** Same database in the shorthand object form — pick whichever you prefer. */
export const ibWorkOrderStores = {
  workOrders: { keyPath: 'id', indexes: { byStatus: 'status', byCreated: 'createdAt' } },
  people: { keyPath: 'id', indexes: { byName: 'name' } },
  assignments: { keyPath: 'id', autoIncrement: true, indexes: { byWorkOrder: 'workOrderId', byPerson: 'personId' } },
  outbox: { keyPath: 'seq', autoIncrement: true },
  meta: 'key',
};

/** Seed used by the demo / tests: one work order, three people, three links. */
export function ibSeedWorkOrder() {
  return {
    workOrders: [{ id: 'WO-1', title: 'Fix pump', status: 'open', createdAt: '2026-01-04' }],
    people: [
      { id: 'P-1', name: 'Ada' },
      { id: 'P-2', name: 'Bo' },
      { id: 'P-3', name: 'Cy' },
    ],
    assignments: [
      { workOrderId: 'WO-1', personId: 'P-1' },
      { workOrderId: 'WO-1', personId: 'P-2' },
      { workOrderId: 'WO-1', personId: 'P-3' },
    ],
  };
}
