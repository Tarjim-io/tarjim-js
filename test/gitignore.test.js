import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ignored = (path) => spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT }).status === 0;

describe('the ignore list', () => {
  it.each(['.env', '.env.local', '.env.production', 'examples/react/.env', 'examples/react/.env.local', 'examples/react/.env.staging.local'])('keeps %s out of the repository', (path) => {
    expect(ignored(path)).toBe(true);
  });

  it.each(['.env.example', 'examples/react/.env.example'])('lets %s in', (path) => {
    expect(ignored(path)).toBe(false);
  });
});
