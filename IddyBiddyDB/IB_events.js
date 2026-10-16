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
 *   { kind: 'idb3-change', change: { store, type, key } }
 */
export function ibListenRemoteChanges(dbName, onChange) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(`idb3:${dbName}`);
  const handler = (event) => {
    if (event.data?.kind === 'idb3-change') onChange(event.data.change);
  };
  channel.addEventListener('message', handler);
  return () => { channel.removeEventListener('message', handler); channel.close(); };
}

/** Tell other tabs / workers that this tab changed something. */
export function ibBroadcastChange(dbName, change) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(`idb3:${dbName}`);
  try { channel.postMessage({ kind: 'idb3-change', change }); } finally { channel.close(); }
}
