import type { SliceFile } from './types.js';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verify(bytes: Uint8Array, expected: SliceFile): Promise<'ok' | 'size' | 'hash'> {
  if (bytes.length !== expected.size) return 'size';
  return (await sha256Hex(bytes)) === expected.hash ? 'ok' : 'hash';
}
