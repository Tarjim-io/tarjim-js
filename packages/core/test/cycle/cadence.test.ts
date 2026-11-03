import { describe, expect, it } from 'vitest';
import { clampRetryAfter, dueAt, failureWaitSeconds } from '../../src/internal.js';

const NOW = 1_700_000_000_000;
const seconds = (n: number) => n * 1000;

describe('clampRetryAfter', () => {
  it.each([
    [0, 0],
    [30, 30],
    [86400, 86400],
    [1_000_000, 86400],
  ])('keeps %s within 0 and 86400 as %s', (value, expected) => {
    expect(clampRetryAfter(value)).toBe(expected);
  });

  it.each([undefined, null, NaN, Infinity, -1, '30'])('reads %s as no wait', (value) => {
    expect(clampRetryAfter(value)).toBe(0);
  });
});

describe('failureWaitSeconds', () => {
  it('waits the 60 second floor when the server names no wait', () => {
    expect(failureWaitSeconds()).toBe(60);
    expect(failureWaitSeconds(0)).toBe(60);
    expect(failureWaitSeconds(30)).toBe(60);
  });

  it('never waits less than the server asked', () => {
    expect(failureWaitSeconds(300)).toBe(300);
  });
});

describe('dueAt', () => {
  it('is now when there has been no check', () => {
    expect(dueAt({}, NOW)).toBe(NOW);
  });

  it('is the last check plus 60 seconds', () => {
    expect(dueAt({ lastCheck: NOW - seconds(10) }, NOW)).toBe(NOW + seconds(50));
    expect(dueAt({ lastCheck: NOW }, NOW)).toBe(NOW + seconds(60));
  });

  it('is already past when the 60 seconds have gone by', () => {
    expect(dueAt({ lastCheck: NOW - seconds(5000) }, NOW)).toBeLessThanOrEqual(NOW);
  });

  it('counts a last check in the future as now', () => {
    expect(dueAt({ lastCheck: NOW + seconds(100_000) }, NOW)).toBe(NOW);
  });

  it('is never before the not-before time', () => {
    const later = NOW + seconds(300);
    expect(dueAt({ lastCheck: NOW - seconds(5000), notBefore: later }, NOW)).toBe(later);
    expect(dueAt({ notBefore: later }, NOW)).toBe(later);
    expect(dueAt({ lastCheck: NOW + seconds(100_000), notBefore: later }, NOW)).toBe(later);
  });

  it('ignores a not-before time earlier than the floor', () => {
    expect(dueAt({ lastCheck: NOW, notBefore: NOW + seconds(10) }, NOW)).toBe(NOW + seconds(60));
    expect(dueAt({ notBefore: NOW - seconds(10) }, NOW)).toBe(NOW);
  });

  it('ignores a wait ending more than a day ahead, which only a clock moved back can leave', () => {
    const far = NOW + seconds(10 * 86400);
    expect(dueAt({ notBefore: far }, NOW)).toBe(NOW);
    expect(dueAt({ lastCheck: NOW - seconds(5000), notBefore: far }, NOW)).toBe(NOW);
  });

  it('keeps a wait that ends within a day', () => {
    const near = NOW + seconds(86400);
    expect(dueAt({ notBefore: near }, NOW)).toBe(near);
  });
});
