const MAX_COMPONENT_DIGITS = 9;

// The version travels raw in the query string, so it is reduced to three plain integers first.
// Null means no usable version, and none is sent: the server then serves the newest app.
export function normaliseAppVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.charAt(0) === 'v' ? raw.slice(1) : raw;
  const numbers = /^[0-9.]*/.exec(text)![0].split('.');
  // "2." leaves an empty part behind the last dot; it is dropped, not rejected.
  if (numbers.length > 1 && numbers[numbers.length - 1] === '') numbers.pop();
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const digits = numbers[i] ?? '0';
    if (!/^[0-9]+$/.test(digits)) return null;
    const part = digits.replace(/^0+(?=[0-9])/, '');
    if (part.length > MAX_COMPONENT_DIGITS) return null;
    parts.push(part);
  }
  return parts.join('.');
}
