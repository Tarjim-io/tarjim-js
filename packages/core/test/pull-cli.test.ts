import { describe, expect, it } from 'vitest';
import { runPullCli } from '../src/pull-cli.js';
import * as fake from '../../../test/helpers/fake-delivery.js';
import { API_KEY, DELIVERY_URL, SIGNED_QUERY, problem } from './support.js';

type Built = { fetch: (url: string, init?: RequestInit) => Promise<Response>; requests: { url: string }[]; meta: Record<string, unknown> };
const buildRelease = fake.buildRelease as unknown as (options: Record<string, unknown>) => Built;
const leaf = (id: string, value: string) => ({ id, value, tags: [] });

function spaRelease(options: Record<string, unknown> = {}) {
  return buildRelease({
    bundles: { c3: { type: 'custom', name: 'spa', layout: 'flat' } },
    slices: {
      c3: {
        en: { schemaVersion: 1, bundle: 'c3', locale: 'en', keys: { 'home.title': leaf('1', 'Home') } },
        ar: { schemaVersion: 1, bundle: 'c3', locale: 'ar', keys: { 'home.title': leaf('1', 'الرئيسية') } },
      },
    },
    ...options,
  });
}

function io(release: Built) {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  return {
    files,
    out,
    err,
    io: {
      fetch: release.fetch,
      writeFile: async (path: string, text: string) => void files.set(path, text),
      stdout: (line: string) => void out.push(line),
      stderr: (line: string) => void err.push(line),
    },
  };
}

const ENV = { TARJIM_APIKEY: API_KEY };

describe('tarjim-pull', () => {
  it('writes the chosen slices as one sorted JSON array and prints the release and checksum', async () => {
    const release = spaRelease();
    const t = io(release);

    const code = await runPullCli(['--delivery-url', DELIVERY_URL, '--bundle', 'spa', '--out', 'snapshot.json'], ENV, t.io);

    expect(code).toBe(0);
    const written = JSON.parse(t.files.get('snapshot.json')!) as { bundle: string; locale: string }[];
    expect(written.map((s) => `${s.bundle}/${s.locale}`)).toEqual(['c3/ar', 'c3/en']);
    expect(t.out).toEqual([`release ${String(release.meta['releaseId'])} checksum ${String(release.meta['checksum'])} · spa: ar, en`]);
    expect(t.err).toEqual([]);
  });

  it('writes the same bytes on a second pull of the same release, ending with a newline', async () => {
    const release = spaRelease();
    const first = io(release);
    const second = io(release);
    const args = ['--delivery-url', DELIVERY_URL, '--out', 'a.json'];

    await runPullCli(args, ENV, first.io);
    await runPullCli(args, ENV, second.io);

    expect(first.files.get('a.json')).toBe(second.files.get('a.json'));
    expect(first.files.get('a.json')!.endsWith('\n')).toBe(true);
    expect(first.files.get('a.json')).toContain('\n  {');
  });

  it('takes the delivery URL from TARJIM_DELIVERY_URL when no flag is given', async () => {
    const t = io(spaRelease());

    expect(await runPullCli(['--out', 'a.json'], { ...ENV, TARJIM_DELIVERY_URL: DELIVERY_URL }, t.io)).toBe(0);
  });

  it('accepts repeated --bundle and --locale flags, and the = form', async () => {
    const t = io(spaRelease());

    const code = await runPullCli([`--delivery-url=${DELIVERY_URL}`, '--bundle=spa', '--locale', 'en', '--locale=ar', '--out=a.json'], ENV, t.io);

    expect(code).toBe(0);
    expect((JSON.parse(t.files.get('a.json')!) as unknown[]).length).toBe(2);
  });

  it('sends --app-version on the meta request', async () => {
    const release = spaRelease();
    await runPullCli(['--delivery-url', DELIVERY_URL, '--app-version', '3.0.0', '--out', 'a.json'], ENV, io(release).io);

    expect(release.requests[0]!.url).toContain('appVersion=3.0.0');
  });

  describe('writes nothing and exits 1 with one line on stderr', () => {
    const cases: [string, string[], Record<string, string>, Record<string, unknown>, RegExp][] = [
      ['no key in the environment', ['--delivery-url', DELIVERY_URL, '--out', 'a.json'], {}, {}, /TARJIM_APIKEY/],
      ['a key given as an argument', ['--delivery-url', DELIVERY_URL, '--api-key', API_KEY, '--out', 'a.json'], ENV, {}, /TARJIM_APIKEY/],
      ['no --out', ['--delivery-url', DELIVERY_URL], ENV, {}, /--out/],
      ['no delivery URL', ['--out', 'a.json'], ENV, {}, /--delivery-url/],
      ['an unknown flag', ['--delivery-url', DELIVERY_URL, '--release', '5', '--out', 'a.json'], ENV, {}, /--release/],
      ['a stage with nothing released', ['--delivery-url', DELIVERY_URL, '--out', 'a.json'], ENV, { hooks: [({ kind }: { kind: string }) => (kind === 'meta' ? problem(404, 'delivery.stage_unreleased') : undefined)] }, /no release/],
      ['a slice that fails its hash', ['--delivery-url', DELIVERY_URL, '--out', 'a.json'], ENV, { tamper: { slices: { 'c3/en': 'hash' } } }, /hash/],
      ['an unknown bundle', ['--delivery-url', DELIVERY_URL, '--bundle', 'web', '--out', 'a.json'], ENV, {}, /bundle "web"/],
    ];
    it.each(cases)('for %s', async (_label, argv, env, options, reason) => {
      const t = io(spaRelease(options));

      const code = await runPullCli(argv, env, t.io);

      expect(code).toBe(1);
      expect(t.files.size).toBe(0);
      expect(t.out).toEqual([]);
      expect(t.err).toHaveLength(1);
      expect(t.err[0]).toMatch(/^tarjim-pull: /);
      expect(t.err[0]).toMatch(reason);
      expect(t.err[0]).not.toContain(API_KEY);
    });
  });

  it('never prints the key or a signed URL', async () => {
    const t = io(spaRelease());
    await runPullCli(['--delivery-url', DELIVERY_URL, '--out', 'a.json'], ENV, t.io);

    const printed = [...t.out, ...t.err].join('\n');
    expect(printed).not.toContain(API_KEY);
    expect(printed).not.toContain(SIGNED_QUERY);
    expect(printed).not.toContain('http');
  });

  it('prints its usage with --help and exits 0 without a request', async () => {
    const release = spaRelease();
    const t = io(release);

    expect(await runPullCli(['--help'], {}, t.io)).toBe(0);
    expect(t.out.join('\n')).toMatch(/--delivery-url/);
    expect(release.requests).toHaveLength(0);
  });
});
