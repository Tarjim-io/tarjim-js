// Under jsdom, Vite rewrites `new URL('../x', import.meta.url)` into a localhost URL relative to the
// project root, which the shared core test helpers then hand to fileURLToPath. Used as
// `vi.mock('node:url', () => import('./helpers/node-url-mock.js'))` at the top of a test file.
// getBuiltinModule, because importing node:url here would resolve to this very mock.
const real = process.getBuiltinModule('node:url');
const root = real.fileURLToPath(new real.URL('../../../../', import.meta.url));

export const fileURLToPath = (url: string | URL): string => {
  const text = String(url);
  return text.startsWith('http://localhost:3000/') ? root + text.slice('http://localhost:3000/'.length) : real.fileURLToPath(url);
};
export const { pathToFileURL, URL, URLSearchParams, parse, format, resolve, domainToASCII, domainToUnicode, urlToHttpOptions, fileURLToPathBuffer } = real as typeof real & { fileURLToPathBuffer?: unknown };
export default { ...real, fileURLToPath };
