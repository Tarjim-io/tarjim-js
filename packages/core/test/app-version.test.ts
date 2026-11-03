import { describe, expect, it } from 'vitest';
import { normaliseAppVersion } from '../src/internal.js';

describe('normaliseAppVersion', () => {
  it.each([
    ['v2.3.0', '2.3.0'],
    ['2.3.0', '2.3.0'],
    ['2.3.0-rc.1', '2.3.0'],
    ['2.3.0-4-gabc', '2.3.0'],
    ['1.02', '1.2.0'],
    ['2.1', '2.1.0'],
    ['2', '2.0.0'],
    ['2.', '2.0.0'],
    ['1.2.3.4', '1.2.3'],
    ['v', null],
    ['vv1.2.3', null],
    ['', null],
    ['abc', null],
    ['99999999999999999999', null],
    ['1..2', null],
    ['123456789.0.1', '123456789.0.1'],
    ['1234567890.0.1', null],
    ['0000000001.2.3', '1.2.3'],
    ['007.0.00', '7.0.0'],
    ['2.1.0+build.5', '2.1.0'],
  ])('turns %j into %j', (raw, expected) => {
    expect(normaliseAppVersion(raw)).toBe(expected);
  });

  it.each([[undefined], [null], [42], [{}], [[]], [true], [Symbol('v')], [10n]])(
    'finds no version in the non-string %s',
    (raw) => {
      expect(normaliseAppVersion(raw)).toBeNull();
    },
  );

  it('never throws, even for a value whose string conversion throws', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(normaliseAppVersion(hostile)).toBeNull();
    expect(normaliseAppVersion('1.0.0')).toBe('1.0.0');
  });
});
