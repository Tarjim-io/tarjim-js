import { describe, expect, it } from 'vitest';
import { parseSlot, slotName } from '../../src/internal.js';

describe('parseSlot', () => {
  it.each([
    ['ui', 'en'],
    ['help.center', 'pt-BR'],
  ])('gives back the bundle and locale that slotName joined (%s, %s)', (bundle, locale) => {
    expect(parseSlot(slotName(bundle, locale))).toEqual({ bundle, locale });
  });

  it.each(['', 'ui', 'ui en'])('reads %j as no slot at all', (name) => {
    expect(parseSlot(name)).toBeUndefined();
  });
});
