// Under jsdom the global Uint8Array is not the realm TextEncoder and fetch's bodies use, so the
// shared fake delivery server (`body instanceof Uint8Array`) would serve JSON-stringified bytes.
Object.defineProperty(Uint8Array, Symbol.hasInstance, {
  value: (value: unknown) => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]',
  configurable: true,
});
