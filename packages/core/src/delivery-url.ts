const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// The URL is used exactly as given and its path is never parsed, so it must be clean: the query
// string the client appends has to be the only one.
export function deliveryUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'deliveryUrl is required';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'deliveryUrl is not a URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) {
    return 'deliveryUrl must be https';
  }
  if (url.username || url.password || value.includes('?') || value.includes('#')) {
    return 'deliveryUrl must not have credentials, a query or a fragment';
  }
  return value.endsWith('/') ? 'deliveryUrl must not end with a slash' : null;
}
