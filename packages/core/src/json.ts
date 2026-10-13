export const HEX64 = /^[0-9a-f]{64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `__proto__` is skipped so a parsed key of that name can never be assigned onto a result object.
export function entriesOf(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([key]) => key !== '__proto__');
}

export function parseJson(bytes: Uint8Array | undefined): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
