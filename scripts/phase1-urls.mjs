function parseOrigin(value, message) {
  let url;
  try { url = new URL(value); } catch { throw new Error(message); }
  // Comparing against the canonical origin also rejects credentials, paths,
  // empty query/fragment delimiters and noncanonical extra URL components.
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (value !== url.origin && value !== `${url.origin}/`)) throw new Error(message);
  return url;
}

export function hostedOrigin(value) {
  const url = parseOrigin(value, 'Invalid hosted issuer origin');
  if (url.protocol !== 'https:') throw new Error('Invalid hosted issuer origin');
  return url.origin;
}

export function loopbackOrigin(value) {
  const url = parseOrigin(value, 'Invalid loopback control origin');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid loopback control origin');
  return url.origin;
}
