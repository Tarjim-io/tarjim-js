import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RELEASE = join(ROOT, 'scripts/release-packages.sh');
const SET_VERSION = join(ROOT, 'scripts/set-version.mjs');
const WORKFLOW = join(ROOT, '.github/workflows/release-packages.yml');

const PACKAGES = ['core', 'browser', 'react'];
const MANIFESTS = PACKAGES.map((name) => `packages/${name}/package.json`);
const VERSION_TS = 'packages/core/src/version.ts';

const read = (root, file) => readFileSync(join(root, file), 'utf8');
const manifestVersion = (root, name) => JSON.parse(read(root, `packages/${name}/package.json`)).version;
const sdkVersion = (root) => /SDK_VERSION = '([^']*)'/.exec(read(root, VERSION_TS))[1];

// The scripts read relative paths, so they run with the temp copy as cwd.
function makeRepo({ core = '0.1.0', browser = core, react = core, sdk = core } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'packages-'));
  const versions = { core, browser, react };
  for (const name of PACKAGES) {
    const file = `packages/${name}/package.json`;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(
      join(root, file),
      read(ROOT, file).replace(/("version": ")[^"]*/, `$1${versions[name]}`),
    );
  }
  mkdirSync(dirname(join(root, VERSION_TS)), { recursive: true });
  writeFileSync(join(root, VERSION_TS), read(ROOT, VERSION_TS).replace(/(SDK_VERSION = ')[^']*/, `$1${sdk}`));
  return root;
}

function run(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return { ok: false, status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const release = (tag, repo) => run('bash', [RELEASE, '--tag', tag], repo);
const setVersion = (version, repo) => run('node', [SET_VERSION, version], repo);

describe('release-packages script', () => {
  it.each([
    ['v0.1.0-alpha.1', '0.1.0-alpha.1', 'alpha'],
    ['v0.1.0-beta.3', '0.1.0-beta.3', 'beta'],
    ['v0.2.0', '0.2.0', 'latest'],
    ['v1.10.0-beta.12', '1.10.0-beta.12', 'beta'],
  ])('accepts %s and prints only the channel', (tag, version, channel) => {
    const result = release(tag, makeRepo({ core: version }));
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(`${channel}\n`);
  });

  it.each([
    ['a tag without the v', '0.1.0'],
    ['a version without a patch number', 'v0.1'],
    ['a release candidate', 'v0.1.0-rc.1'],
    ['a prerelease without a number', 'v0.1.0-alpha'],
    ['an upper-case channel', 'v0.1.0-ALPHA.1'],
    ['build metadata', 'v0.1.0+build.1'],
    ['a reference client tag', 'reference-v0.1.0'],
    ['a leading zero', 'v01.0.0'],
    ['an empty tag', ''],
  ])('refuses %s', (_what, tag) => {
    // The files agree with the tag where the tag has a version, so only the grammar can refuse.
    const version = tag.replace(/^v/, '') || '0.1.0';
    const result = release(tag, makeRepo({ core: version }));
    expect(result.ok).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/\[ERROR\] .*tag/);
  });

  it.each([
    ['the core package', { core: '0.1.1' }],
    ['the browser package', { browser: '0.1.1' }],
    ['the react package', { react: '0.1.1' }],
    ['SDK_VERSION', { sdk: '0.1.1' }],
  ])('refuses when %s differs from the tag', (_place, override) => {
    const result = release('v0.1.0', makeRepo({ core: '0.1.0', ...override }));
    expect(result.ok).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/\[ERROR\] .*0\.1\.1/);
  });

  it('accepts when all four places match the tag', () => {
    const result = release('v0.1.0', makeRepo({ core: '0.1.0' }));
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('latest\n');
  });
});

describe('set-version script', () => {
  it.each(['0.2.0', '0.1.0-alpha.2', '3.0.0-beta.1'])('writes %s to all four places', (version) => {
    const repo = makeRepo({ core: '0.1.0' });
    const result = setVersion(version, repo);
    expect(result.ok).toBe(true);
    for (const name of PACKAGES) expect(manifestVersion(repo, name)).toBe(version);
    expect(sdkVersion(repo)).toBe(version);
  });

  it('changes nothing in a package.json but the version value', () => {
    const repo = makeRepo({ core: '0.1.0' });
    const before = MANIFESTS.map((file) => read(repo, file));
    setVersion('0.2.0-beta.1', repo);
    MANIFESTS.forEach((file, i) => {
      expect(read(repo, file)).toBe(before[i].replace('"version": "0.1.0"', '"version": "0.2.0-beta.1"'));
    });
  });

  it.each(['0.1', 'v0.1.0', '0.1.0-rc.1', '0.1.0-alpha', '0.1.0-ALPHA.1', '0.1.0+build.1', '01.0.0', ''])(
    'refuses "%s" and leaves every file untouched',
    (version) => {
      const repo = makeRepo({ core: '0.1.0' });
      const files = [...MANIFESTS, VERSION_TS];
      const before = files.map((file) => read(repo, file));
      const result = setVersion(version, repo);
      expect(result.ok).toBe(false);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toMatch(/Cannot find module/);
      expect(result.stderr).toMatch(/version/i);
      expect(files.map((file) => read(repo, file))).toEqual(before);
    },
  );
});

describe('the repository', () => {
  it('has the same version in all three packages and in SDK_VERSION', () => {
    const versions = PACKAGES.map((name) => manifestVersion(ROOT, name));
    expect([...versions, sdkVersion(ROOT)]).toEqual(Array(4).fill(versions[0]));
  });
});

// GitHub tag filters: * stops at /, ** does not, [..] is a character class.
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      source += glob.slice(i, end + 1);
      i = end;
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function tagPatterns(yaml) {
  const inline = /^\s*tags:\s*\[(.*)\]\s*$/m.exec(yaml);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const block = /^(\s*)tags:\s*\n((?:\1\s+-\s*.*\n?)+)/m.exec(yaml);
  if (!block) return [];
  return block[2].split('\n').filter((l) => l.trim()).map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''));
}

describe('the release workflow', () => {
  it('exists', () => {
    expect(existsSync(WORKFLOW)).toBe(true);
  });

  it('fires on package tags and not on reference client tags', () => {
    expect(existsSync(WORKFLOW)).toBe(true);
    const patterns = tagPatterns(readFileSync(WORKFLOW, 'utf8'));
    expect(patterns.length).toBeGreaterThan(0);
    const matches = (tag) => patterns.some((p) => globToRegExp(p).test(tag));
    expect(matches('v0.1.0-alpha.1')).toBe(true);
    expect(matches('v0.2.0')).toBe(true);
    expect(matches('reference-v0.1.0')).toBe(false);
  });
});

describe('publishable packages', () => {
  describe.each(PACKAGES)('%s', (name) => {
    const manifest = () => JSON.parse(readFileSync(join(ROOT, `packages/${name}/package.json`), 'utf8'));

    it('is not private', () => {
      expect(manifest().private).not.toBe(true);
    });

    it('publishes publicly', () => {
      expect(manifest().publishConfig?.access).toBe('public');
    });

    it('names its directory in the repository field', () => {
      expect(manifest().repository?.directory).toBe(`packages/${name}`);
    });

    it('declares the supported node versions', () => {
      expect(typeof manifest().engines?.node).toBe('string');
    });

    it('carries a LICENSE file', () => {
      expect(existsSync(join(ROOT, `packages/${name}/LICENSE`))).toBe(true);
    });
  });

  it('keeps the root package and the examples private', () => {
    for (const file of ['package.json', 'examples/react/package.json']) {
      expect(JSON.parse(readFileSync(join(ROOT, file), 'utf8')).private).toBe(true);
    }
  });
});
