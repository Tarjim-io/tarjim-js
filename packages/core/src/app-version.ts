// The version travels raw in the query string, so it is reduced to three plain integers first.
export function normaliseAppVersion(raw: unknown): string {
  if (typeof raw !== 'string') return '0.0.0';
  const text = raw.charAt(0) === 'v' ? raw.slice(1) : raw;
  const numbers = /^[0-9.]*/.exec(text)![0].split('.');
  // "2." leaves an empty part behind the last dot; it is dropped, not rejected.
  if (numbers.length > 1 && numbers[numbers.length - 1] === '') numbers.pop();
  const parts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const digits = numbers[i] ?? '0';
    const value = /^[0-9]+$/.test(digits) ? parseInt(digits, 10) : NaN;
    if (!Number.isSafeInteger(value)) return '0.0.0';
    parts.push(value);
  }
  const result = parts.join('.');
  return result.length > 32 ? '0.0.0' : result;
}
