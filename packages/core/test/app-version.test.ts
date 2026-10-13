import { describe, expect, it } from 'vitest';
import { normaliseAppVersion } from '../src/index.js';

describe('normaliseAppVersion', () => {
  it.each([
    ['v2.3.0', '2.3.0'],
    ['2.3.0', '2.3.0'],
    ['2.3.0-rc.1', '2.3.0'],
    ['2.3.0-4-gabc', '2.3.0'],
    ['1.02', '1.2'],
    ['2.1', '2.1.0'],
    ['2', '2.0.0'],
    ['2.', '2.0.0'],
    ['1.2.3.4', '1.2.3'],
    ['v', '0.0.0'],
    ['vv1.2.3', '0.0.0'],
    ['', '0.0.0'],
    ['abc', '0.0.0'],
    ['99999999999999999999', '0.0.0'],
    ['1..2', '0.0.0'],
  ])('turns %j into %j', (raw, expected) => {
    expect(normaliseAppVersion(raw)).toBe(expected);
  });

  it.each([[undefined], [null], [42], [{}], [[]], [true], [Symbol('v')], [10n]])(
    'answers 0.0.0 for the non-string %s',
    (raw) => {
      expect(normaliseAppVersion(raw)).toBe('0.0.0');
    },
  );

  it('answers 0.0.0 when the result would be longer than 32 characters', () => {
    const big = '9007199254740991';
    expect(normaliseAppVersion(`${big}.${big}.${big}`)).toBe('0.0.0');
    expect(normaliseAppVersion('1.2.3')).toBe('1.2.3');
  });

  it('never throws, even for a value whose string conversion throws', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(normaliseAppVersion(hostile)).toBe('0.0.0');
    expect(normaliseAppVersion('1.0.0')).toBe('1.0.0');
  });
});
