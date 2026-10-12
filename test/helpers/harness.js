import { loadReference } from './load-reference.js';
import { API_KEY } from './fake-delivery.js';

export const DEFAULT_BUNDLE = { type: 'namespace', name: 'default' };

const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Loads the client in a fresh context with the globals a browser page would give it, and starts it
 * against `fake` (anything with `fetch` and `deliveryUrl`). Reports and console calls are collected
 * as plain data. `globals` overrides or adds context globals (a `crypto: undefined` simulates an
 * insecure context); `config` overrides the default configuration.
 */
export function createHarness(fake, { config = {}, globals = {} } = {}) {
  const reports = [];
  const debugCalls = [];
  const otherConsoleCalls = [];
  const spyConsole = {
    debug: (...args) => debugCalls.push(plain(args)),
    log: (...args) => otherConsoleCalls.push(['log', plain(args)]),
    info: (...args) => otherConsoleCalls.push(['info', plain(args)]),
    warn: (...args) => otherConsoleCalls.push(['warn', plain(args)]),
    error: (...args) => otherConsoleCalls.push(['error', plain(args)]),
  };

  const TarjimReference = loadReference({
    crypto: globalThis.crypto,
    console: spyConsole,
    URL,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    ...globals,
  });

  const fullConfig = {
    deliveryUrl: fake.deliveryUrl,
    apiKey: API_KEY,
    appVersion: '1.0.0',
    defaultBundle: DEFAULT_BUNDLE,
    fallbackLanguage: 'en',
    fetch: fake.fetch,
    onReport: (report) => reports.push(plain(report)),
    ...config,
  };

  return {
    TarjimReference,
    reports,
    debugCalls,
    otherConsoleCalls,
    config: fullConfig,
    codes: () => reports.map((report) => report.code),
    start: (overrides = {}) => TarjimReference.start({ ...fullConfig, ...overrides }),
  };
}

export async function startClient(fake, options) {
  const harness = createHarness(fake, options);
  const client = await harness.start();
  return { client, ...harness };
}

// A stand-in for a browser object the client must not touch: every property access is recorded.
export function accessSpy(name, log) {
  return new Proxy(
    {},
    {
      get(_, property) {
        log.push(`${name}.${String(property)}`);
        return undefined;
      },
      set(_, property) {
        log.push(`${name}.${String(property)}=`);
        return true;
      },
      has(_, property) {
        log.push(`${name} has ${String(property)}`);
        return false;
      },
    },
  );
}

export const plainData = plain;
