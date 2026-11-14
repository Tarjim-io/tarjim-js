import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { runPullCli } from '../pull-cli.js';

// The file appears whole or not at all: a reader never sees half a snapshot, and a failed run
// leaves the previous one in place.
async function replaceFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

process.exitCode = await runPullCli(process.argv.slice(2), process.env, {
  fetch: (url, init) => fetch(url, init),
  writeFile: replaceFile,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
