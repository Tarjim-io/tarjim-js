import { pull } from './pull.js';
import type { FetchFunction } from './types.js';

export interface PullIo {
  fetch: FetchFunction;
  /** Must replace the file whole or leave it untouched: the command writes only after every check passed. */
  writeFile(path: string, text: string): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
}

export const PULL_USAGE = `Usage: TARJIM_APIKEY=<stage key> tarjim-pull --delivery-url <url> --out <file> [options]

Downloads slices of the stage's current release, verified like the SDK verifies them, and writes
them to <file> as one JSON array to pass as \`embedded\`.

  --delivery-url <url>   the distribution's Delivery URL (or set TARJIM_DELIVERY_URL)
  --out <file>           where to write the JSON array
  --bundle <name>        a bundle to include; repeat for more (default: every bundle)
  --locale <tag>         a locale to include; repeat for more (default: every locale)
  --app-version <x.y.z>  the app version to ask for (default: the newest app)
  --help                 print this message

The key is read from TARJIM_APIKEY only. On any failure nothing is written and the exit code is 1.`;

interface Parsed {
  deliveryUrl?: string;
  out?: string;
  appVersion?: string;
  bundles: string[];
  locales: string[];
  help: boolean;
}

const VALUE_FLAGS = new Set(['--delivery-url', '--out', '--bundle', '--locale', '--app-version']);

function parse(argv: readonly string[]): Parsed | string {
  const parsed: Parsed = { bundles: [], locales: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (/^--api-?key$/i.test(flag)) return 'the key is read from TARJIM_APIKEY only, never from an argument';
    if (!VALUE_FLAGS.has(flag)) return `unknown option ${flag.startsWith('-') ? flag : JSON.stringify(flag)}`;
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') return `${flag} needs a value`;
    if (flag === '--delivery-url') parsed.deliveryUrl = value;
    else if (flag === '--out') parsed.out = value;
    else if (flag === '--app-version') parsed.appVersion = value;
    else if (flag === '--bundle') parsed.bundles.push(value);
    else parsed.locales.push(value);
  }
  return parsed;
}

/** Runs the command; returns the exit code. Prints one line on stdout on success, one on stderr on failure. */
export async function runPullCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: PullIo): Promise<number> {
  const failed = (reason: string): number => {
    io.stderr(`tarjim-pull: ${reason}`);
    return 1;
  };
  const parsed = parse(argv);
  if (typeof parsed === 'string') return failed(parsed);
  if (parsed.help) {
    io.stdout(PULL_USAGE);
    return 0;
  }
  const apiKey = env['TARJIM_APIKEY'];
  if (!apiKey) return failed('no key: set TARJIM_APIKEY to the stage key');
  const deliveryUrl = parsed.deliveryUrl ?? env['TARJIM_DELIVERY_URL'];
  if (!deliveryUrl) return failed('no delivery URL: pass --delivery-url or set TARJIM_DELIVERY_URL');
  if (!parsed.out) return failed('no output file: pass --out <file>');

  const result = await pull({
    deliveryUrl,
    apiKey,
    bundles: parsed.bundles,
    locales: parsed.locales,
    fetch: io.fetch,
    ...(parsed.appVersion === undefined ? {} : { appVersion: parsed.appVersion }),
  });
  if (!result.ok) return failed(result.reason);
  try {
    await io.writeFile(parsed.out, `${JSON.stringify(result.slices, null, 2)}\n`);
  } catch {
    return failed(`could not write ${parsed.out}`);
  }
  io.stdout(`release ${result.releaseId} checksum ${result.checksum}`);
  return 0;
}
