import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/secret-scan.sh', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function scan(content) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const file = join(dir, 'sample.txt');
  writeFileSync(file, content);
  try {
    execFileSync('bash', [SCRIPT, file], { stdio: 'pipe' });
    return { found: false, output: '' };
  } catch (error) {
    return { found: error.status === 1, output: String(error.stdout) + String(error.stderr), status: error.status };
  }
}

// Assembled at run time so this file itself carries nothing the scan would flag.
const realLookingKey = ['tarjim', '42', '7', '3', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'].join('-');
const longSignature = 'Signature=' + 'Ab9_-~'.repeat(20);
const longPolicy = 'Policy=' + 'eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNl'.repeat(2);
const keyPairId = 'Key-Pair-Id=K' + 'X'.repeat(13);

// Hosts and ticket ids, assembled for the same reason.
const tarjimHost = (name) => [name, 'tarjim', 'io'].join('.');
const cdnHost = ['d1a2b3c4d5e6f7', 'cloudfront', 'net'].join('.');
const awsHost = ['bucket', 's3', 'eu-west-1', 'amazonaws', 'com'].join('.');
const ticket = ['TJ', '540'].join('-');

describe('host and ticket scan', () => {
  it.each([
    ['a staging delivery host', `https://${tarjimHost('delivery.staging')}/t/1/meta`],
    ['the app host', `fetch('https://${tarjimHost('app')}/api')`],
    ['a host in capitals', tarjimHost('APP').toUpperCase()],
    ['a CloudFront distribution host', `connect-src https://${cdnHost}`],
    ['an AWS host', `https://${awsHost}/key`],
    ['a ticket id', `fixes ${ticket}`],
    ['a ticket id at the start of a line', `${ticket}: the cause`],
  ])('flags %s', (_what, content) => {
    const result = scan(`before\n${content}\nafter\n`);
    expect(result.found).toBe(true);
    expect(result.output).toContain('sample.txt:2');
  });

  it.each([
    ['the public API host', `https://${tarjimHost('api')}/v1`],
    ['example hosts', 'https://delivery.example.com/meta and https://api.example.org'],
    ['reserved hosts', 'https://delivery.example.invalid/t/1/meta'],
    ['the CloudFront wildcard in a policy', 'connect-src https://*.cloudfront.net'],
    ['the GitHub organisation', 'https://github.com/Tarjim-io/tarjim-js'],
    ['an algorithm name', 'SHA-256 and SHA-384'],
    ['a word ending in the ticket letters', ['ROUTJ', '42'].join('-')],
  ])('passes %s', (_what, content) => {
    expect(scan(`${content}\n`)).toEqual({ found: false, output: '' });
  });
});

describe('secret scan', () => {
  it.each([
    ['an API key', realLookingKey],
    ['an API key in a header', `X-Tarjim-Apikey: ${realLookingKey}`],
    ['a CloudFront signature', `https://cdn.example.invalid/m.json?${longSignature}`],
    ['a CloudFront policy', longPolicy],
    ['a CloudFront key pair id', keyPairId],
  ])('flags %s', (_what, content) => {
    const result = scan(`before\n${content}\nafter\n`);
    expect(result.found).toBe(true);
    // The finding names the file and line, never the secret itself.
    expect(result.output).toContain('sample.txt:2');
    expect(result.output).not.toContain(content.slice(-12));
  });

  it.each([
    ['the placeholder key', 'tarjim-0-0-0-testkey'],
    ['the invalid key the capture sends', 'tarjim-0-0-0-invalid'],
    ['redacted signatures', 'Policy=REDACTED&Signature=REDACTED&Key-Pair-Id=REDACTED'],
    ['short test signatures', 'Policy=P1&Signature=S1&Key-Pair-Id=K1'],
    ['a key-shaped pattern in prose', 'keys look like tarjim-<tenant>-<project>-…'],
  ])('passes %s', (_what, content) => {
    expect(scan(`${content}\n`)).toEqual({ found: false, output: '' });
  });

  // Scans every tracked file, which takes seconds while the rest of the suite runs in parallel.
  it('passes every file tracked in this repository', { timeout: 30_000 }, () => {
    expect(() => execFileSync('bash', [SCRIPT], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });
});
