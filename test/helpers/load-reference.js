import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE_PATH = new URL('../../reference/tarjim-reference.js', import.meta.url);

// Evaluated as a classic script in a fresh context, as a browser would, so a stray `export` or a
// dependency on Node's module scope fails here.
export function loadReference(globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(readFileSync(SOURCE_PATH, 'utf8'), context, { filename: 'tarjim-reference.js' });
  return context.TarjimReference;
}
