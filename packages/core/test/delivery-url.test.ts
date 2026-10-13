import { describe, expect, it } from 'vitest';
import { deliveryUrlProblem } from '../src/index.js';

describe('deliveryUrlProblem', () => {
  it.each([
    'https://delivery.example.invalid/t/1/projects/1/delivery/meta',
    'https://example.com/meta',
    'http://localhost/meta',
    'http://localhost:3000/t/1/meta',
    'http://127.0.0.1:8080/meta',
    'http://[::1]:8080/meta',
  ])('accepts %s', (url) => {
    expect(deliveryUrlProblem(url)).toBeNull();
  });

  it.each([
    ['plain http on a real host', 'http://delivery.example.invalid/meta'],
    ['http on a host that only starts with localhost', 'http://localhost.example.invalid/meta'],
    ['a query', 'https://delivery.example.invalid/meta?x=1'],
    ['an empty query marker', 'https://delivery.example.invalid/meta?'],
    ['a fragment', 'https://delivery.example.invalid/meta#top'],
    ['credentials', 'https://user:pass@delivery.example.invalid/meta'],
    ['a user name only', 'https://user@delivery.example.invalid/meta'],
    ['a trailing slash', 'https://delivery.example.invalid/meta/'],
    ['a non-http scheme', 'ftp://delivery.example.invalid/meta'],
    ['text that is not a URL', 'not a url'],
    ['the empty string', ''],
  ])('refuses %s with a reason', (_label, url) => {
    expect(typeof deliveryUrlProblem(url)).toBe('string');
  });

  it.each([[undefined], [null], [42], [{}], [['https://example.com/meta']]])('refuses the non-string %j', (value) => {
    expect(typeof deliveryUrlProblem(value)).toBe('string');
  });

  it('does not alter the value it is given', () => {
    const url = 'https://delivery.example.invalid/t/1/projects/1/delivery/meta';
    const copy = `${url}`;
    expect(deliveryUrlProblem(url)).toBeNull();
    expect(url).toBe(copy);
  });
});
