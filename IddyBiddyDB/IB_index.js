// IB_index.js — public entry point. Import everything from here:
//
//   import { ibOpenDatabase } from './IddyBiddyDB/IB_index.js';
//
// Layers (import a single file instead if you only need one layer):
//   IB_db.js / IB_table.js     open a database, tables, single-record CRUD
//   IB_pipeline.js             fluent queries (where/join/sort/page/stream)
//   IB_query.js / IB_join.js   pure array helpers (filter/sort/group/joins)
//   IB_grid-adapter.js         wa-data-grid + generic data-request components
//   IB_sync.js                 server <-> IndexedDB sync (outbox, conflicts)
//   IB_worker-client.js        run sync in a Web Worker (+ IB_sync-worker.js)
//   IB_codecs.js               optional binary (Uint8Array) store encoding

export { ibOpenDatabase, ibListDatabases, ibDeleteDatabase, ibDatabase, ibGetAllRecords, ibPutAllRecords, ibTxDone, ibNormalizeStores, ibReqToPromise, ibTableReadAll } from './IB_db.js';
export { ibTable, ibToEntries, ibApplyPatch, ibAbortError } from './IB_table.js';
export { ibQuery } from './IB_pipeline.js';
export {
  ibFieldPath, ibFieldValues, ibApplyFilters, ibApplySearch, ibApplySort, ibNormalizeSort, ibNormalizeFilters, ibMatches,
  ibPaginate, ibProject, ibGroupRows, ibAggregate, ibAggregateBy, ibDistinct, ibKeyRangeFor, ibOPS,
} from './IB_query.js';
export { ibHashIndex, ibInnerJoin, ibLeftJoin, ibLookup, ibMaterializeNest, ibNestViaLink, ibUnnest } from './IB_join.js';
export { ibQueryStore, ibFetchFromIDB3, ibCreateDataSource, ibCreateDataRequestHandler, ibBindDataGrid, ibNormalizeGridRequest } from './IB_grid-adapter.js';
export { ibWrapValue, ibUnwrapValue, ibRegisterCodec, ibGetCodec, ibJsonBytesCodec } from './IB_codecs.js';
export {
  ibPullFromServer, ibPushOutbox, ibEnqueueMutation, ibPendingMutations, ibResolveConflict,
  ibGetMeta, ibSetMeta, ibFetchSyncAdapter, ibSyncEngine, ibCreateSyncEngine,
} from './IB_sync.js';
export { ibSyncWorkerClient, ibCreateSyncWorker } from './IB_worker-client.js';
export { ibChangeBus, ibListenRemoteChanges, ibBroadcastChange } from './IB_events.js';
export { ibIDB3Error } from './IB_internal.js';
export { ibWorkOrderSchemas, ibWorkOrderStores, ibDefineStore, ibSeedWorkOrder } from './IB_schemas.js';
