// IB_codecs.js — OPTIONAL binary layer. Default is structured-clone passthrough:
// IndexedDB natively stores objects, arrays, Date, Map, Set, Blob, File and
// ArrayBuffer, by value. You only need this file when a store should persist
// a compact Uint8Array payload instead (wire dumps, pre-compressed snapshots).
//
// Set `binary: true` per table call:  table.put(record, { binary: true })
// Codec is pluggable: ibRegisterCodec('msgpack', { encode, decode }) backed by
// MessagePack/CBOR when size matters; the built-in JSON codec needs no deps
// and round-trips Map/Set/Date (plain JSON.stringify would lose them).

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const TAG = '__idb3_type__';

function replacer(key, value) {
  // JSON.stringify runs Date#toJSON before the replacer, so inspect the holder.
  const original = this?.[key];
  if (original instanceof Date) return { [TAG]: 'Date', value: original.toISOString() };
  if (value instanceof Map) return { [TAG]: 'Map', entries: [...value.entries()] };
  if (value instanceof Set) return { [TAG]: 'Set', values: [...value.values()] };
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === 'object' && value[TAG]) {
    if (value[TAG] === 'Map') return new Map(value.entries);
    if (value[TAG] === 'Set') return new Set(value.values);
    if (value[TAG] === 'Date') return new Date(value.value);
  }
  return value;
}

export const ibJsonBytesCodec = {
  encode(value) {
    if (!textEncoder) throw new Error('TextEncoder unavailable');
    return textEncoder.encode(JSON.stringify(value, replacer));
  },
  decode(bytes) {
    if (!textDecoder) throw new Error('TextDecoder unavailable');
    return JSON.parse(textDecoder.decode(bytes), reviver);
  },
};

const registry = new Map([['json-bytes', ibJsonBytesCodec]]);

export function ibRegisterCodec(name, codec) {
  if (typeof codec?.encode !== 'function' || typeof codec?.decode !== 'function') {
    throw new TypeError('ibRegisterCodec: codec needs { encode(value)->Uint8Array, decode(bytes)->value }');
  }
  registry.set(name, codec);
}

export function ibGetCodec(name = 'json-bytes') { return registry.get(name); }

export function ibWrapValue(value, { binary = false, codec = 'json-bytes' } = {}) {
  if (!binary) return value;
  const bytes = registry.get(codec)?.encode(value);
  if (!(bytes instanceof Uint8Array)) throw new Error(`codec ${codec} must encode to Uint8Array`);
  return bytes;
}

export function ibUnwrapValue(stored, { binary = false, codec = 'json-bytes' } = {}) {
  if (!binary) return stored;
  if (!(stored instanceof Uint8Array)) throw new Error('expected Uint8Array payload');
  return registry.get(codec)?.decode(stored);
}
