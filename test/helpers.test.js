import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_URL,
  buildRelease,
  hangUntilAborted,
  leaf,
  makeSlice,
  respond,
  serveRecording,
  sha256Hex,
} from './helpers/fake-delivery.js';

const RECORDING = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/recorded/release-1');

describe('fake delivery: recorded release', () => {
  it('serves the meta, manifest and objects and logs every request', async () => {
    const served = serveRecording(RECORDING);
    const metaResponse = await served.fetch(`${DELIVERY_URL}?appVersion=1.0.0`, { method: 'GET' });
    const meta = await metaResponse.json();
    expect(metaResponse.status).toBe(200);

    const manifestBytes = new Uint8Array(await (await served.fetch(`${meta.manifestUrl}?${meta.signedQuery}`)).arrayBuffer());
    expect(sha256Hex(manifestBytes)).toBe(meta.checksum);

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const { hash, size } = manifest.slices.ns180.en.json;
    const object = await served.fetch(`${meta.slicesBaseUrl}${hash}.json?${meta.signedQuery}`);
    expect((await object.arrayBuffer()).byteLength).toBe(size);

    expect((await served.fetch('https://delivery.example.invalid/elsewhere')).status).toBe(404);
    expect(served.requests).toHaveLength(4);
  });
});

describe('fake delivery: built release', () => {
  const bundles = { ns1: { type: 'namespace', name: 'default' } };
  const slices = { ns1: { en: makeSlice('ns1', 'en', { a: leaf(1, 'A') }) } };

  it('computes hashes, sizes and the manifest checksum', async () => {
    const release = buildRelease({ bundles, slices });
    const meta = await (await release.fetch(DELIVERY_URL)).json();
    const manifestBytes = new Uint8Array(await (await release.fetch(meta.manifestUrl)).arrayBuffer());
    expect(sha256Hex(manifestBytes)).toBe(meta.checksum);

    const entry = release.manifest.slices.ns1.en.json;
    const body = new Uint8Array(await (await release.fetch(`${meta.slicesBaseUrl}${entry.hash}.json`)).arrayBuffer());
    expect(sha256Hex(body)).toBe(entry.hash);
    expect(body.length).toBe(entry.size);
  });

  it('resolves origin-mode relative URLs against the delivery URL', async () => {
    const release = buildRelease({ mode: 'origin', bundles, slices });
    expect(release.meta.authenticated).toBe(true);
    const manifestUrl = new URL(release.meta.manifestUrl, DELIVERY_URL).href;
    expect((await release.fetch(manifestUrl)).status).toBe(200);
  });

  it('tampers with a body, a size or the manifest on request', async () => {
    const tampered = buildRelease({ bundles, slices, tamper: { slices: { 'ns1/en': 'hash' }, manifest: true } });
    const entry = tampered.manifest.slices.ns1.en.json;
    const body = new Uint8Array(await (await tampered.fetch(`${tampered.meta.slicesBaseUrl}${entry.hash}.json`)).arrayBuffer());
    expect(sha256Hex(body)).not.toBe(entry.hash);
    const manifest = new Uint8Array(await (await tampered.fetch(tampered.meta.manifestUrl)).arrayBuffer());
    expect(sha256Hex(manifest)).not.toBe(tampered.meta.checksum);

    const wrongSize = buildRelease({ bundles, slices, tamper: { slices: { 'ns1/en': 'size' } } });
    const sized = wrongSize.manifest.slices.ns1.en.json;
    const served = await (await wrongSize.fetch(`${wrongSize.meta.slicesBaseUrl}${sized.hash}.json`)).arrayBuffer();
    expect(served.byteLength).not.toBe(sized.size);
  });

  it('lets a hook answer, fail or change the meta, with a per-name request count', async () => {
    const release = buildRelease({ bundles, slices });
    const seen = [];
    release.hook(({ kind, nth }) => {
      seen.push([kind, nth]);
      if (kind === 'manifest' && nth === 0) return respond(503, '{}');
      if (kind === 'object') return new TypeError('Failed to fetch');
    });
    expect((await release.fetch(release.meta.manifestUrl)).status).toBe(503);
    expect((await release.fetch(release.meta.manifestUrl)).status).toBe(200);
    await expect(release.fetch(`${release.meta.slicesBaseUrl}x.json`)).rejects.toThrow(TypeError);
    expect(seen).toEqual([['manifest', 0], ['manifest', 1], ['object', 0]]);

    release.setMeta({ signedQuery: 'Policy=P2' });
    expect((await (await release.fetch(DELIVERY_URL)).json()).signedQuery).toBe('Policy=P2');
  });

  it('can fake a redirected response and a hanging request', async () => {
    expect(respond(200, '{}', { redirected: true }).redirected).toBe(true);
    expect(respond(200, '{}', { type: 'opaqueredirect' }).type).toBe('opaqueredirect');
    const controller = new AbortController();
    const hanging = hangUntilAborted({ signal: controller.signal });
    controller.abort();
    await expect(hanging).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lists extra file types with their own hashes', () => {
    const release = buildRelease({ bundles, slices, extraTypes: ['strings', 'xml'] });
    expect(Object.keys(release.manifest.slices.ns1.en)).toEqual(['json', 'strings', 'xml']);
  });
});
