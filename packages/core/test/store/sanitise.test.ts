import { describe, expect, it } from 'vitest';
import { sanitiseInstall, sanitiseState } from '../../src/index.js';
import { makeInstall } from '../helpers/store-contract.js';

describe('sanitiseInstall', () => {
  it.each([NaN, Infinity, -Infinity])('reads an install whose installedAt is %s as absent', (installedAt) => {
    expect(sanitiseInstall(makeInstall({}, { installedAt }))).toBeUndefined();
  });

  it('keeps an install with an ordinary installedAt', () => {
    expect(sanitiseInstall(makeInstall({}))).toEqual(makeInstall({}));
  });
});

describe('sanitiseState', () => {
  it.each([NaN, Infinity])('drops a reported map that holds %s', (bad) => {
    expect(sanitiseState({ reported: { a: 1, b: bad } }).reported).toBeUndefined();
  });

  it('keeps a reported map of finite numbers', () => {
    expect(sanitiseState({ reported: { a: 1, b: 2 } }).reported).toEqual({ a: 1, b: 2 });
  });
});
