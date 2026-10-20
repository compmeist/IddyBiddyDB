// IB_events.js — the change bus. Every write in the library announces itself here
// so grids, live queries and sync can react without polling.
//
// Two audiences, one bus:
//   * JavaScript code:  db.on('change', ({ store, type, key }) => { ... })
//   * DOM components:   a CustomEvent('idb3:change') on the same target, so a
//                       Web Awesome element (or any element) can listen too.
//
// Change shape: { store, type: 'put'|'add'|'delete'|'clear'|'bulk', key?, record?, keys? }

export class ibChangeBus extends EventTarget {
  /** Subscribe. Returns an unsubscribe function. */
  on(type, listener, options) {
    this.addEventListener(type, listener, options);
    return () => this.removeEventListener(type, listener, options);
  }

  /** Announce a record change on both the JS and the DOM channel. */
  emitChange(change) {
    this.dispatchEvent(new CustomEvent('change', { detail: change }));
    this.dispatchEvent(new CustomEvent('idb3:change', { detail: change, bubbles: false }));
    if (change?.store) {
      this.dispatchEvent(new CustomEvent(`change:${change.store}`, { detail: change }));
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * Listen for changes coming from other tabs / workers over BroadcastChannel.
 * Returns a stop function. Channel messages look like:
 *   { kind: 'idb3-change', change: { store, type, key }, source?: string }
 *
 * `opts.sourceId` (or a plain string) identifies the local sender: messages
 * carrying that same id are our own broadcasts echoed back by the channel
 * and are ignored, so a tab never treats its own write as a remote change.
 * Messages without a source (e.g. IB_sync-worker.js) are always accepted.
 */
export function ibListenRemoteChanges(dbName, onChange, opts = {}) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const sourceId = typeof opts === 'string' ? opts : opts?.sourceId;
  let channel;
  try { channel = new BroadcastChannel(`idb3:${dbName}`); } catch { return () => {}; }
  const handler = (event) => {
    if (event.data?.kind !== 'idb3-change') return;
    if (sourceId && event.data.source === sourceId) return;
    onChange(event.data.change);
  };
  if (typeof channel.addEventListener === 'function') channel.addEventListener('message', handler);
  else channel.onmessage = handler;
  return () => {
    if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', handler);
    if (channel.onmessage === handler) channel.onmessage = null;
    channel.close();
  };
}

/** Tell other tabs / workers that this tab changed something. */
export function ibBroadcastChange(dbName, change, sourceId) {
  if (typeof BroadcastChannel === 'undefined') return;
  let channel;
  try {
    channel = new BroadcastChannel(`idb3:${dbName}`);
    channel.postMessage(sourceId
      ? { kind: 'idb3-change', change, source: sourceId }
      : { kind: 'idb3-change', change });
  } catch { /* cross-tab is best-effort; the local write already succeeded */ } finally {
    try { channel?.close(); } catch { /* ignore */ }
  }
}
