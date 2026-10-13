import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const path = (relative) => `${ROOT}${relative}`;
const read = (relative) => readFileSync(path(relative), 'utf8');
const BUNDLE = 'packages/browser/dist/tarjim-browser.iife.js';
const VARIANT = 'examples/plain-html/with-package.html';

// Reading inside a test keeps a missing file an assertion failure rather than a crash at load.
function readExisting(relative) {
  expect(existsSync(path(relative)), `${relative} is missing`).toBe(true);
  return read(relative);
}

function allowedHost(host) {
  return host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.invalid');
}

function hostsIn(text) {
  return [...text.matchAll(/https?:\/\/([^/\s'"`)<>:]+)/g)].map((match) => match[1]);
}

describe('the script-tag build', () => {
  it('is written next to the other build output', () => {
    expect(existsSync(path(BUNDLE)), `${BUNDLE} is missing; build first`).toBe(true);
  });

  it('defines Tarjim with only start and version', () => {
    const source = readExisting(BUNDLE);
    const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, console };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    const namespace = sandbox.Tarjim;
    expect(namespace).toBeDefined();
    expect(Object.keys(namespace).sort()).toEqual(['start', 'version']);
    expect(typeof namespace.start).toBe('function');
    expect(typeof namespace.version).toBe('string');
  });

  it('leaves no other global behind', () => {
    const source = readExisting(BUNDLE);
    const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const before = new Set(Object.keys(sandbox));
    vm.runInContext(source, sandbox);
    expect(Object.keys(sandbox).filter((name) => !before.has(name))).toEqual(['Tarjim']);
  });
});

describe('examples/plain-html with the package', () => {
  const scriptTags = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];

  it('loads the built file with its sha384 and anonymous cross-origin mode', () => {
    const html = readExisting(VARIANT);
    const built = readExisting(BUNDLE);
    const tag = scriptTags(html).find((match) => /tarjim-browser\.iife\.js/.test(match[1]));
    expect(tag, 'no script tag for tarjim-browser.iife.js').toBeDefined();

    const integrity = /integrity="(sha384-[A-Za-z0-9+/]+=*)"/.exec(tag[1]);
    expect(integrity, 'no sha384 integrity attribute').not.toBeNull();
    expect(integrity[1]).toBe(`sha384-${createHash('sha384').update(readFileSync(path(BUNDLE))).digest('base64')}`);
    expect(tag[1]).toMatch(/crossorigin="anonymous"/);
    expect(built.length).toBeGreaterThan(0);
  });

  it('has no inline script and a strict script policy', () => {
    const html = readExisting(VARIANT);
    for (const match of scriptTags(html)) expect(match[2].trim()).toBe('');
    expect(html).toMatch(/script-src 'self';/);
    expect(html).toMatch(/connect-src [^"]*https:\/\/delivery\.example\.com/);
  });

  it('keeps its configuration in a separate file that names only example hosts', () => {
    const html = readExisting(VARIANT);
    const sources = scriptTags(html).map((match) => /src="([^"]+)"/.exec(match[1])?.[1]);
    const config = sources.find((src) => src && !/tarjim-browser\.iife\.js/.test(src));
    expect(config, 'no external config script').toBeDefined();

    const text = readExisting(`examples/plain-html/${config}`);
    expect(text).toMatch(/Tarjim\.start\(/);
    expect(text).toMatch(/waitForContent/);
    const hosts = hostsIn(text);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(allowedHost(host), host).toBe(true);
  });

  it('names no real host in the page either', () => {
    const html = readExisting(VARIANT);
    // The CloudFront wildcard is the one deliberate exception, explained in the README.
    const hosts = hostsIn(html.replaceAll('https://*.cloudfront.net', ''));
    for (const host of hosts) expect(allowedHost(host), host).toBe(true);
  });

  it('never writes HTML into the page from any example file', () => {
    expect(existsSync(path(VARIANT))).toBe(true);
    const files = readdirSync(path('examples/plain-html'));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files.filter((name) => /\.(html|js)$/.test(name))) {
      // A comment may name innerHTML to warn against it; only code counts.
      const text = read(`examples/plain-html/${file}`)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s\/\/ .*$/gm, '');
      expect(text, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write\(/);
    }
  });
});

describe('the size budget', () => {
  it('lists the script-tag build', () => {
    const source = read('scripts/size-budget.mjs');
    expect(source).toContain('@tarjim/browser (script tag)');
    expect(source).toContain('tarjim-browser.iife');
  });

  it('passes with the script-tag build measured', () => {
    const run = spawnSync(process.execPath, [path('scripts/size-budget.mjs')], { cwd: ROOT, encoding: 'utf8' });
    expect(run.stdout).toContain('@tarjim/browser (script tag):');
    expect(run.stdout).not.toContain('OVER BUDGET');
    expect(run.status).toBe(0);
  });
});

// Each entry is a statement a reader must find; the patterns are stable keywords, so a rewording
// that keeps the meaning still passes and a dropped statement does not.
const STATEMENTS = [
  ['values are untrusted text', [/untrusted/i, /textContent/]],
  ['entry attributes are an allow-list', [/entry\(\)\.attributes/, /allow-?list/i]],
  ['content security policy connect-src', [/connect-src/]],
  ['self-host with integrity', [/self-host/i, /integrity/i]],
  ['appVersion changes on every deploy', [/appVersion/, /every deploy/i]],
  ['embedded holds only what is needed, in search order', [/embedded/i, /search order/i]],
  ['prebuilt pages are rebuilt on release', [/prebuilt/i, /rebuild/i]],
  ['install id consent', [/install id/i, /consent/i]],
  ['persistent storage is the site’s choice', [/persist\(\)/]],
  ['pre-release status', [/not yet for customers/i, /0\.x/]],
];

describe.each([
  ['packages/core/README.md', ['self-host with integrity']],
  ['packages/browser/README.md', []],
])('%s', (file, notRequired) => {
  for (const [statement, patterns] of STATEMENTS) {
    if (notRequired.includes(statement)) continue;
    it(`states: ${statement}`, () => {
      const text = readExisting(file);
      for (const pattern of patterns) expect(text, String(pattern)).toMatch(pattern);
    });
  }
});

describe('docs/migrating-from-tarjim-react-client.md', () => {
  const FILE = 'docs/migrating-from-tarjim-react-client.md';
  const rowFor = (text, name) => text.split('\n').find((line) => new RegExp(`(^|[^\\w])${name}(?!\\w)`).test(line));

  it('exists', () => {
    expect(existsSync(path(FILE))).toBe(true);
  });

  it.each(['__T', '__TS', '__TM', 'setCurrentLocale', 'cachedTarjimData'])('maps %s to its replacement', (name) => {
    const row = rowFor(readExisting(FILE), name);
    expect(row, `no line mentions ${name}`).toBeDefined();
    const codeSpans = row.match(/`[^`]+`/g) ?? [];
    expect(codeSpans.filter((span) => !span.includes(name)).length, row).toBeGreaterThan(0);
  });

  it('points setCurrentLocale at setLanguage', () => {
    expect(rowFor(readExisting(FILE), 'setCurrentLocale')).toMatch(/setLanguage/);
  });
});
