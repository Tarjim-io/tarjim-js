import { describe, expect, it } from 'vitest';
import { referencedHashes, withInstall } from '../../src/internal.js';
import { makeInstall } from '../helpers/store-contract.js';

describe('withInstall', () => {
  const active = makeInstall({ 'ui\nen': 'a'.repeat(64) }, { checksum: '1'.repeat(64) });
  const pending = makeInstall({ 'ui\nen': 'b'.repeat(64) }, { checksum: '2'.repeat(64) });
  const next = makeInstall({ 'ui\nen': 'c'.repeat(64) }, { checksum: '3'.repeat(64) });

  it('puts a pending install beside the active one', () => {
    expect(withInstall({ active, lastCheck: 1 }, next, 'pending')).toEqual({ active, pending: next, lastCheck: 1 });
  });

  it('replaces the active install and clears pending', () => {
    expect(withInstall({ active, pending, lastCheck: 1 }, next, 'active')).toEqual({ active: next, lastCheck: 1 });
  });

  it('does not change the state it was given', () => {
    const state = { active, pending };
    withInstall(state, next, 'active');
    expect(state).toEqual({ active, pending });
  });
});

describe('referencedHashes', () => {
  it('names the hashes of both installs, once each', () => {
    const state = {
      active: makeInstall({ x: 'a'.repeat(64), y: 'b'.repeat(64) }),
      pending: makeInstall({ x: 'b'.repeat(64), y: 'c'.repeat(64) }),
    };
    expect([...referencedHashes(state)].sort()).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  });

  it('is empty for a state with no install', () => {
    expect(referencedHashes({ lastCheck: 1 }).size).toBe(0);
  });
});
