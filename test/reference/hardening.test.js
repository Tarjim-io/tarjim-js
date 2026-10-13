import { describe, expect, it } from 'vitest';
import { buildRelease, leaf, makeSlice } from '../helpers/fake-delivery.js';
import { startClient } from '../helpers/harness.js';

const DEFAULT = { type: 'namespace', name: 'default' };

async function clientFor(keys) {
  const slices = { en: makeSlice('ns1', 'en', keys) };
  return startClient(buildRelease({ bundles: { ns1: DEFAULT }, slices: { ns1: slices } }));
}

describe('media URLs', () => {
  const good = 'https://media.example.com/a.png';

  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,x'],
    ['a plain http URL', 'http://media.example.com/a.png'],
    ['a relative path', '/media/a.png'],
  ])('returns null and reports once for %s', async (_, value) => {
    for (const type of ['image', 'audio', 'video', 'file']) {
      const { client, codes } = await clientFor({ a: leaf(1, value, { type }), b: leaf(2, value, { type }) });
      expect(client.entry('a')).toBe(null);
      expect(client.entry('b')).toBe(null);
      expect(codes()).toEqual(['media-url-rejected']);
    }
  });

  it('keeps the rejected value out of the report', async () => {
    const { reports } = await clientFor({ a: leaf(1, 'javascript:alert(1)', { type: 'image' }) }).then(async (r) => {
      r.client.entry('a');
      return r;
    });
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).not.toContain('javascript');
  });

  it('returns an https media value as it is', async () => {
    const { client, codes } = await clientFor({ a: leaf(1, good, { type: 'image' }), b: leaf(2, good, { type: 'file' }) });
    expect(client.entry('a').value).toBe(good);
    expect(client.entry('b').value).toBe(good);
    expect(codes()).toEqual([]);
  });

  it('leaves text entries and t() alone, whatever the value looks like', async () => {
    const { client, codes } = await clientFor({
      a: leaf(1, 'javascript:alert(1)'),
      b: leaf(2, 'javascript:alert(1)', { type: 'text' }),
      c: leaf(3, 'javascript:alert(1)', { type: 'image' }),
    });
    expect(client.entry('a').value).toBe('javascript:alert(1)');
    expect(client.entry('b').value).toBe('javascript:alert(1)');
    expect(client.t('c')).toBe('javascript:alert(1)');
    expect(codes()).toEqual([]);
  });
});

describe('class names', () => {
  it('returns null for a class that could break out of an attribute', async () => {
    const { client } = await clientFor({
      bad: leaf(1, 'x', { class: 'x" onclick="y' }),
      good: leaf(2, 'x', { class: 'hero big_1-a' }),
    });
    expect(client.entry('bad').className).toBe(null);
    expect(client.entry('good').className).toBe('hero big_1-a');
  });
});
