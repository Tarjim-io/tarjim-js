import { describe, expect, it } from 'vitest';
import type { TarjimEntry } from '../../src/index.js';
import { DEFAULT, leaf, reporter, snapshotOf, snapshotWith, world } from './world.js';

const GOOD = 'https://media.example.com/a.png';

// A rejected media value may come back as no entry or as an entry without a value.
const mediaValue = (entry: TarjimEntry | null): string | null => entry?.value ?? null;

describe('what an entry carries', () => {
  const full = {
    'hero.image': leaf(12, 'https://media.example.com/hero.png', {
      type: 'image',
      class: 'hero',
      attributes: { alt: 'A hero', title: 'Hero', width: '640', height: '480', loading: 'lazy' },
      skip_tid: true,
      text_type: 'plain',
      value_casing: 'upper',
      string_array_child_keys: [],
      plural_child_keys: [],
    }),
  };

  it('returns exactly value, id, type, attributes and className', () => {
    const snapshot = snapshotWith(full);
    expect(snapshot.entry('hero.image')).toEqual({
      value: 'https://media.example.com/hero.png',
      id: '12',
      type: 'image',
      attributes: { alt: 'A hero', title: 'Hero', width: '640', height: '480', loading: 'lazy' },
      className: 'hero',
    });
    expect(Object.keys(snapshot.entry('hero.image') ?? {}).sort()).toEqual(['attributes', 'className', 'id', 'type', 'value']);
  });

  it('gives a plain text entry the defaults', () => {
    expect(snapshotWith({ plain: { id: 5, value: 'Hello' } }).entry('plain')).toEqual({
      value: 'Hello',
      id: '5',
      type: 'text',
      attributes: null,
      className: null,
    });
  });

  it('takes an unusable type for text', () => {
    expect(snapshotWith({ k: leaf(1, 'v', { type: 7 }) }).entry('k')?.type).toBe('text');
  });

  it('reports each media type as it is', () => {
    const snapshot = snapshotWith({
      a: leaf(1, GOOD, { type: 'image' }),
      b: leaf(2, GOOD, { type: 'audio/video' }),
      c: leaf(3, GOOD, { type: 'file' }),
    });
    expect([snapshot.entry('a')?.type, snapshot.entry('b')?.type, snapshot.entry('c')?.type]).toEqual([
      'image',
      'audio/video',
      'file',
    ]);
  });

  it('works for entries in a nested bundle with a namespace option', () => {
    const held = world(
      { c1: { type: 'custom', name: 'ui', layout: 'nested', namespaces: ['n'] } },
      { c1: { en: { schemaVersion: 1, bundle: 'c1', locale: 'en', namespaces: { n: { k: leaf(2, 'nested') } } } } },
    );
    const entry = snapshotOf(held).entry('k', { bundle: { type: 'custom', name: 'ui' }, namespace: 'n' });
    expect(entry?.value).toBe('nested');
    expect(snapshotOf(held).entry('k', { bundle: { type: 'custom', name: 'ui' }, namespace: 'other' })).toBeNull();
  });

  it('returns markup in a value as the same plain string', () => {
    const markup = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    const snapshot = snapshotWith({
      html: leaf(1, markup),
      image: leaf(2, GOOD, { type: 'image', attributes: { alt: markup } }),
    });
    expect(snapshot.t('html')).toBe(markup);
    expect(snapshot.entry('html')?.value).toBe(markup);
    expect(snapshot.entry('image')?.attributes).toEqual({ alt: markup });
  });
});

describe('when an entry is null', () => {
  it('is null for a missing key and for an empty value, and not for a filled one', () => {
    const snapshot = snapshotWith({ empty: leaf(1, ''), ok: leaf(2, 'x') });
    expect(snapshot.entry('missing')).toBeNull();
    expect(snapshot.entry('empty')).toBeNull();
    expect(snapshot.entry('ok')).not.toBeNull();
  });

  it.each([
    ['a number', 7],
    ['an object', { a: 1 }],
    ['an array', ['a']],
    ['null', null],
  ])('is null for a value that is %s', (_, value) => {
    const snapshot = snapshotWith({ k: { id: '1', value } });
    expect(snapshot.entry('k')).toBeNull();
    expect(snapshot.t('k')).toBe('k');
  });

  it.each([
    ['missing', '{"value":"v"}'],
    ['null', '{"id":null,"value":"v"}'],
    ['an object', '{"id":{"a":1},"value":"v"}'],
    ['a boolean', '{"id":true,"value":"v"}'],
    ['an array', '{"id":[1],"value":"v"}'],
    ['too large to be finite', '{"id":1e400,"value":"v"}'],
  ])('is null for a leaf whose id is %s, while t still answers', (_, leafJson) => {
    const text = `{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{"k":${leafJson}}}`;
    const snapshot = snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: text } }));
    expect(snapshot.entry('k')).toBeNull();
    expect(snapshot.t('k')).toBe('v');
  });

  it('accepts a string or a finite number as the id', () => {
    const snapshot = snapshotWith({ a: { id: 'x1', value: 'v' }, b: { id: 12, value: 'v' } });
    expect(snapshot.entry('a')?.id).toBe('x1');
    expect(snapshot.entry('b')?.id).toBe('12');
  });
});

describe('attributes', () => {
  it('keeps only the allow-listed names with string values', () => {
    const snapshot = snapshotWith({
      one: leaf(1, GOOD, {
        type: 'image',
        attributes: { alt: 'ok', onerror: 'alert(1)', style: 'x', class: 'sneaky', width: 640, 'data-x': 'y', loading: 'lazy' },
      }),
      two: leaf(2, GOOD, { type: 'image', attributes: { onclick: 'z' } }),
    });
    expect(snapshot.entry('one')?.attributes).toEqual({ alt: 'ok', loading: 'lazy' });
    expect(snapshot.entry('one')?.className).toBeNull();
    expect(snapshot.entry('two')?.attributes).toBeNull();
  });

  it('reports the dropped ones, without the key or the values', () => {
    const { report, reports, codes } = reporter();
    const snapshot = snapshotWith(
      { 'secret.hero.key': leaf(1, GOOD, { type: 'image', attributes: { alt: 'ok', onerror: 'payload-text' } }) },
      { report },
    );
    snapshot.entry('secret.hero.key');
    expect(codes()).toContain('attribute-dropped');
    expect(codes().every((code) => code === 'attribute-dropped')).toBe(true);
    const text = JSON.stringify(reports);
    expect(text).not.toContain('secret.hero.key');
    expect(text).not.toContain('payload-text');
  });

  it('reports nothing when every attribute is allowed', () => {
    const { report, codes } = reporter();
    const snapshot = snapshotWith({ k: leaf(1, GOOD, { type: 'image', attributes: { alt: 'a', title: 't' } }) }, { report });
    snapshot.entry('k');
    expect(codes()).toEqual([]);
  });

  it.each([
    ['an array', ['alt']],
    ['a string', 'alt=x'],
    ['a number', 7],
    ['null', null],
  ])('treats attributes that are %s as none', (_, attributes) => {
    expect(snapshotWith({ k: leaf(1, 'v', { attributes }) }).entry('k')?.attributes).toBeNull();
  });
});

describe('class names', () => {
  it('returns null for a class that could break out of an attribute and keeps a safe one', () => {
    const snapshot = snapshotWith({
      bad: leaf(1, 'x', { class: 'x" onclick="y' }),
      angle: leaf(2, 'x', { class: 'a<b' }),
      number: leaf(3, 'x', { class: 5 }),
      good: leaf(4, 'x', { class: 'hero big_1-a' }),
    });
    expect(snapshot.entry('bad')?.className).toBeNull();
    expect(snapshot.entry('angle')?.className).toBeNull();
    expect(snapshot.entry('number')?.className).toBeNull();
    expect(snapshot.entry('good')?.className).toBe('hero big_1-a');
  });
});

describe('media values', () => {
  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,x'],
    ['a plain http URL', 'http://media.example.com/a.png'],
    ['a relative path', '/media/a.png'],
    ['text that is not a URL', 'not a url'],
  ])('is not returned for %s, and is reported once per entry', (_, value) => {
    for (const type of ['image', 'audio/video', 'file']) {
      const { report, codes } = reporter();
      const snapshot = snapshotWith({ a: leaf(1, value, { type }) }, { report });
      expect(mediaValue(snapshot.entry('a'))).toBeNull();
      expect(codes()).toEqual(['media-url-rejected']);
    }
  });

  it('keeps the rejected value and the key out of the report', () => {
    const { report, reports } = reporter();
    const snapshot = snapshotWith({ 'private.key': leaf(1, 'javascript:alert(1)', { type: 'image' }) }, { report });
    snapshot.entry('private.key');
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('javascript');
    expect(JSON.stringify(reports)).not.toContain('private.key');
  });

  it('returns an https media value as it is, with no report', () => {
    const { report, codes } = reporter();
    const snapshot = snapshotWith({ a: leaf(1, GOOD, { type: 'image' }), b: leaf(2, GOOD, { type: 'file' }) }, { report });
    expect(snapshot.entry('a')?.value).toBe(GOOD);
    expect(snapshot.entry('b')?.value).toBe(GOOD);
    expect(codes()).toEqual([]);
  });

  it('leaves text entries and t alone, whatever the value looks like', () => {
    const { report, codes } = reporter();
    const snapshot = snapshotWith(
      {
        a: leaf(1, 'javascript:alert(1)'),
        b: leaf(2, 'javascript:alert(1)', { type: 'text' }),
        c: leaf(3, 'javascript:alert(1)', { type: 'image' }),
      },
      { report },
    );
    expect(snapshot.entry('a')?.value).toBe('javascript:alert(1)');
    expect(snapshot.entry('b')?.value).toBe('javascript:alert(1)');
    expect(snapshot.t('c')).toBe('javascript:alert(1)');
    expect(codes()).toEqual([]);
  });
});
