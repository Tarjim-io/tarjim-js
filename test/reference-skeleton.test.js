import { describe, expect, it } from 'vitest';
import { loadReference } from './helpers/load-reference.js';

describe('reference client file', () => {
  it('runs as a classic script and assigns TarjimReference', () => {
    const TarjimReference = loadReference();
    expect(typeof TarjimReference.start).toBe('function');
    expect(TarjimReference.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
