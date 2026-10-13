import type { SliceFile } from './types.js';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The DOM typings refuse a view that might be backed by a SharedArrayBuffer; ours never is.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verify(bytes: Uint8Array, expected: SliceFile): Promise<'ok' | 'size' | 'hash'> {
  if (bytes.length !== expected.size) return 'size';
  return (await sha256Hex(bytes)) === expected.hash ? 'ok' : 'hash';
}
