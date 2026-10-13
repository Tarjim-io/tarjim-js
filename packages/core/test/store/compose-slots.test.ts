import { describe, expect, it } from 'vitest';
import { composeSlots } from '../../src/index.js';
import { makeInstall } from '../helpers/store-contract.js';

describe('composeSlots', () => {
  it('takes the verified hash for every slot that verified', () => {
    const result = composeSlots(undefined, ['ui\nen', 'ui\nfr'], new Map([['ui\nen', 'h1'], ['ui\nfr', 'h2']]));
    expect(result).toEqual({ slots: { 'ui\nen': 'h1', 'ui\nfr': 'h2' }, owed: [] });
  });

  it('lets one unverified slot keep the previous hash without blocking the others', () => {
    const previous = makeInstall({ 'ui\nen': 'old-en', 'ui\nfr': 'old-fr' });
    const result = composeSlots(
      previous,
      ['ui\nen', 'ui\nfr', 'help\nen'],
      new Map([['ui\nen', 'new-en'], ['help\nen', 'new-help']]),
    );
    expect(result.slots).toEqual({ 'ui\nen': 'new-en', 'ui\nfr': 'old-fr', 'help\nen': 'new-help' });
    expect(result.owed).toEqual([]);
  });

  it('owes an unverified slot that the previous install did not have', () => {
    const previous = makeInstall({ 'ui\nen': 'old-en' });
    const result = composeSlots(previous, ['ui\nen', 'ui\nfr'], new Map([['ui\nen', 'new-en']]));
    expect(result.slots).toEqual({ 'ui\nen': 'new-en' });
    expect(result.owed).toEqual(['ui\nfr']);
  });

  it('owes every unverified slot when there is no previous install', () => {
    const result = composeSlots(undefined, ['ui\nen', 'ui\nfr'], new Map([['ui\nen', 'h1']]));
    expect(result).toEqual({ slots: { 'ui\nen': 'h1' }, owed: ['ui\nfr'] });
  });

  it('owes everything when nothing verified and nothing was held', () => {
    expect(composeSlots(undefined, ['ui\nen', 'ui\nfr'], new Map())).toEqual({
      slots: {},
      owed: ['ui\nen', 'ui\nfr'],
    });
  });

  it('leaves out slots that are no longer wanted', () => {
    const previous = makeInstall({ 'ui\nen': 'old-en', 'ui\nde': 'old-de' });
    const result = composeSlots(previous, ['ui\nen'], new Map([['ui\nen', 'new-en']]));
    expect(result.slots).toEqual({ 'ui\nen': 'new-en' });
  });

  it('does not change the previous install', () => {
    const previous = makeInstall({ 'ui\nen': 'old-en' });
    const before = JSON.stringify(previous);
    composeSlots(previous, ['ui\nen', 'ui\nfr'], new Map([['ui\nfr', 'h']]));
    expect(JSON.stringify(previous)).toBe(before);
  });
});
