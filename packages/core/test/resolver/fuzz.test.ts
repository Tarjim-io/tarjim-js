import { describe, expect, it } from 'vitest';
import { decodeSlice } from '../../src/index.js';
import type { Snapshot } from '../../src/index.js';
import { DEFAULT, flatSlice, leaf, pluralKeys, snapshotOf, world } from './world.js';

// Mulberry32: the same garbage on every run.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

function scalar(rand: Rand): unknown {
  return pick(rand, [null, true, false, 0, -1, 1.5, 1e21, 'x', '', '{name}', '%s %d %1$s %%', 'https://media.example.com/a.png', 'javascript:alert(1)', '1', '9'.repeat(400)]);
}

function junk(rand: Rand, depth = 0): unknown {
  const kind = rand();
  if (depth > 3 || kind < 0.5) return scalar(rand);
  if (kind < 0.75) return Array.from({ length: Math.floor(rand() * 4) }, () => junk(rand, depth + 1));
  const object: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(rand() * 4); i++) object[pick(rand, ['id', 'value', 'type', 'class', 'attributes', 'a', '__proto__', 'constructor'])] = junk(rand, depth + 1);
  return object;
}

function garbageLeaf(rand: Rand, ids: number): unknown {
  if (rand() < 0.2) return junk(rand);
  const idList = () => (rand() < 0.2 ? junk(rand) : Array.from({ length: Math.floor(rand() * 4) }, () => (rand() < 0.7 ? Math.floor(rand() * ids) : junk(rand, 3))));
  const out: Record<string, unknown> = {};
  if (rand() < 0.9) out.id = rand() < 0.8 ? Math.floor(rand() * ids) : junk(rand);
  if (rand() < 0.9) out.value = rand() < 0.7 ? pick(rand, ['v', '', '%d {count} %s', 'https://media.example.com/a.png', 'javascript:x']) : junk(rand);
  if (rand() < 0.4) out.type = rand() < 0.5 ? pick(rand, ['image', 'audio/video', 'file', 'text']) : junk(rand);
  if (rand() < 0.3) out.class = rand() < 0.5 ? pick(rand, ['hero', 'x" y']) : junk(rand);
  if (rand() < 0.4) out.attributes = rand() < 0.5 ? { alt: 'a', onerror: 'x', width: 5 } : junk(rand);
  if (rand() < 0.5) out.plural_child_keys = idList();
  if (rand() < 0.5) out.string_array_child_keys = idList();
  return out;
}

const NAMES = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', '__proto__', 'constructor', 'toString', 'missing', ''];

function garbageSlice(rand: Rand): unknown {
  const keys: Record<string, unknown> = {};
  for (const name of NAMES.slice(0, 6)) keys[name] = garbageLeaf(rand, 8);
  keys[`k0.${pick(rand, ['one', 'other', 'few', 'zero'])}`] = garbageLeaf(rand, 8);
  const layout = rand();
  const body = layout < 0.6 ? { keys } : layout < 0.85 ? { namespaces: { a: keys, b: junk(rand), c: null } } : { keys: junk(rand), namespaces: junk(rand) };
  return { schemaVersion: rand() < 0.9 ? 1 : junk(rand), bundle: 'ns1', locale: 'en', ...body };
}

const ARGS: unknown[] = [undefined, null, 0, 'str', [], [1, 2], {}, { count: 3 }, { count: NaN }, { count: Infinity }, { count: -1 }, { count: 1e21 }, { count: 1.5 }, { name: 'x' }, ['%s', '{x}']];
const OPTIONS: unknown[] = [undefined, {}, { namespace: 'a' }, { namespace: 5 }, { bundle: { type: 'custom', name: 'nope' } }, { bundle: null }, { bundle: 5 }, { bundle: DEFAULT }];

function sweep(snapshot: Snapshot) {
  const t = snapshot.t as (key: string, args?: unknown, options?: unknown) => unknown;
  const tArray = snapshot.tArray as (key: string, options?: unknown) => unknown;
  const entry = snapshot.entry as (key: string, options?: unknown) => unknown;
  for (const name of NAMES) {
    for (const args of ARGS) expect(typeof t(name, args)).toBe('string');
    for (const options of OPTIONS) {
      expect(typeof t(name, undefined, options)).toBe('string');
      const list = tArray(name, options);
      expect(Array.isArray(list)).toBe(true);
      for (const item of list as unknown[]) expect(typeof item).toBe('string');
      const found = entry(name, options) as Record<string, unknown> | null;
      if (found !== null) {
        expect(Object.keys(found).sort()).toEqual(['attributes', 'className', 'id', 'type', 'value']);
        expect(typeof found.value).toBe('string');
        expect(typeof found.id).toBe('string');
      }
    }
  }
}

describe('lookups over garbage', () => {
  it('never throw and always return the right type, over generated slices as downloaded bytes', () => {
    const rand = random(20261013);
    for (let i = 0; i < 150; i++) {
      const text = JSON.stringify(garbageSlice(rand));
      sweep(snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: text } })));
    }
  });

  it('never throw over generated slices given as embedded objects', () => {
    const rand = random(7);
    for (let i = 0; i < 150; i++) {
      sweep(snapshotOf(null, { embedded: [garbageSlice(rand) as never, garbageSlice(rand) as never] }));
    }
  });

  it('never throw over generated slices in both places at once', () => {
    const rand = random(99);
    for (let i = 0; i < 80; i++) {
      const downloaded = world({ ns1: DEFAULT }, { ns1: { en: JSON.stringify(garbageSlice(rand)) } });
      sweep(snapshotOf(downloaded, { embedded: [garbageSlice(rand) as never] }));
    }
  });

  it('never throw over every truncation of a valid slice', () => {
    const text = JSON.stringify(flatSlice('ns1', 'en', { a: leaf(1, 'A'), ...pluralKeys('p', 10, { one: 'o', other: 'm' }) }));
    for (let end = 0; end <= text.length; end += 3) {
      sweep(snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: text.slice(0, end) } })));
    }
  });

  it('never throw over random bytes, a byte order mark and invalid UTF-8', () => {
    const rand = random(5);
    const bodies: Uint8Array[] = [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      new Uint8Array([0xff, 0xfe, 0x00]),
      new Uint8Array(0),
      new TextEncoder().encode(`{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{"k0":{"id":1,"value":"\\ud800"}}}`),
    ];
    for (let i = 0; i < 40; i++) bodies.push(Uint8Array.from({ length: 1 + Math.floor(rand() * 200) }, () => Math.floor(rand() * 256)));
    for (const bytes of bodies) sweep(snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: bytes } })));
  });

  it('never throw over a very deeply nested slice', () => {
    const deep = '['.repeat(50_000) + ']'.repeat(50_000);
    const text = `{"schemaVersion":1,"bundle":"ns1","locale":"en","keys":{"k0":{"id":1,"value":"v","attributes":${deep},"plural_child_keys":${deep}}}}`;
    sweep(snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: text } })));
  });

  it('never throw when a plural parent lists itself or a cycle of children', () => {
    const keys = {
      k0: { id: '1', value: 'self', plural_child_keys: [1], string_array_child_keys: [1] },
      k1: { id: '2', value: 'A', plural_child_keys: [3], string_array_child_keys: [3] },
      'k1.one': { id: '3', value: 'A one', plural_child_keys: [2], string_array_child_keys: [2] },
    };
    sweep(snapshotOf(world({ ns1: DEFAULT }, { ns1: { en: flatSlice('ns1', 'en', keys) } })));
  });

  it('never throw when embedded slices are hostile objects', () => {
    const trap = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
    const cyclic: Record<string, unknown> = { schemaVersion: 1, bundle: 'ns1', locale: 'en' };
    cyclic.keys = cyclic;
    sweep(snapshotOf(null, { embedded: [trap, cyclic, { schemaVersion: 1, bundle: 'ns1', locale: 'en', keys: trap }] as never }));
  });
});

describe('decoding garbage', () => {
  it('never throws and answers a decoded slice or null', () => {
    const rand = random(123);
    for (let i = 0; i < 300; i++) {
      const result = decodeSlice(rand() < 0.8 ? garbageSlice(rand) : junk(rand));
      expect(result === null || result.namespaces instanceof Map).toBe(true);
    }
  });
});
