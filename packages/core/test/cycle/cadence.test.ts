import { describe, expect, it } from 'vitest';
import { backoffSeconds, clampPollAfter, clampRetryAfter, dueAt } from '../../src/index.js';
import type { State } from '../../src/index.js';

const NOW = 1_700_000_000_000;
const seconds = (n: number) => n * 1000;

describe('clampPollAfter', () => {
  it.each([
    [900, 900],
    [60, 60],
    [86400, 86400],
    [30, 60],
    [0, 60],
    [100000, 86400],
  ])('keeps %s within 60 and 86400 as %s', (value, expected) => {
    expect(clampPollAfter(value)).toBe(expected);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, '900', {}])('falls back to 1800 for %s', (value) => {
    expect(clampPollAfter(value)).toBe(1800);
  });

  it('falls back to the value it is given', () => {
    expect(clampPollAfter(undefined, 300)).toBe(300);
    expect(clampPollAfter(-5, 300)).toBe(300);
    expect(clampPollAfter(120, 300)).toBe(120);
  });
});

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

describe('backoffSeconds', () => {
  it.each([
    [0, 900, 60],
    [1, 900, 120],
    [2, 900, 240],
    [3, 900, 480],
    [4, 900, 900],
    [12, 900, 900],
    [0, 30, 30],
  ])('step %s with a poll interval of %s waits %s seconds', (step, pollAfter, expected) => {
    expect(backoffSeconds(step, pollAfter)).toBe(expected);
  });

  it('never waits less than the server asked', () => {
    expect(backoffSeconds(0, 900, 300)).toBe(300);
    expect(backoffSeconds(5, 900, 1200)).toBe(1200);
    expect(backoffSeconds(0, 900, 0)).toBe(60);
    expect(backoffSeconds(3, 900, 100)).toBe(480);
  });

  it('never waits more than a day', () => {
    expect(backoffSeconds(0, 900, 1_000_000)).toBe(86400);
    expect(backoffSeconds(30, 86400)).toBe(86400);
  });

  it('grows with the step until it reaches the poll interval', () => {
    const waits = [0, 1, 2, 3, 4, 5].map((step) => backoffSeconds(step, 900));
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(new Set(waits).size).toBe(5);
  });
});

describe('dueAt', () => {
  const polled = (overrides: State = {}): State => ({ lastCheck: NOW - seconds(100), lastPollAfter: 900, ...overrides });

  it('is now when there has been no check', () => {
    expect(dueAt({}, NOW, 0)).toBe(NOW);
    expect(dueAt({ lastPollAfter: 900 }, NOW, 0.7)).toBe(NOW);
  });

  it('is the last check plus the poll interval', () => {
    expect(dueAt(polled(), NOW, 0)).toBe(NOW - seconds(100) + seconds(900));
  });

  it('adds up to 20 percent of the interval with the random value', () => {
    const base = NOW - seconds(100);
    expect(dueAt(polled(), NOW, 0.5)).toBe(base + seconds(990));
    expect(dueAt(polled(), NOW, 1)).toBe(base + seconds(1080));
  });

  it('uses 1800 seconds when no interval is known', () => {
    expect(dueAt({ lastCheck: NOW }, NOW, 0)).toBe(NOW + seconds(1800));
  });

  it('is already past when the interval has gone by', () => {
    expect(dueAt({ lastCheck: NOW - seconds(5000), lastPollAfter: 900 }, NOW, 0)).toBeLessThanOrEqual(NOW);
  });

  it('counts a last check in the future as now', () => {
    expect(dueAt({ lastCheck: NOW + seconds(100_000), lastPollAfter: 900 }, NOW, 0)).toBe(NOW);
    expect(dueAt({ lastCheck: NOW + seconds(100_000), lastPollAfter: 900 }, NOW, 1)).toBe(NOW);
  });

  it('is never before the not-before time', () => {
    const later = NOW + seconds(300);
    expect(dueAt(polled({ lastCheck: NOW - seconds(5000), notBefore: later }), NOW, 0)).toBe(later);
    expect(dueAt({ notBefore: later }, NOW, 0)).toBe(later);
    expect(dueAt({ lastCheck: NOW + seconds(100_000), notBefore: later }, NOW, 0)).toBe(later);
  });

  it('ignores a not-before time that is earlier than the regular due time', () => {
    const regular = NOW - seconds(100) + seconds(900);
    expect(dueAt(polled({ notBefore: NOW + seconds(10) }), NOW, 0)).toBe(regular);
    expect(dueAt({ notBefore: NOW - seconds(10) }, NOW, 0)).toBe(NOW);
  });
});
