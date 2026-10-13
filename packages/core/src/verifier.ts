import type { SliceFile } from './types.js';

export async function sha256Hex(_bytes: Uint8Array): Promise<string> {
  throw new Error('not implemented');
}

export async function verify(_bytes: Uint8Array, _expected: SliceFile): Promise<'ok' | 'size' | 'hash'> {
  throw new Error('not implemented');
}
