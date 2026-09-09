export function resolveApiRoute(input) {
  const url = input instanceof URL ? new URL(input) : new URL(input, 'http://localhost');
  if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
    url.pathname = `/api${url.pathname.slice('/api/v1'.length)}`;
    return { url, version: 1, prefix: '/api/v1', legacy: false };
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    return { url, version: 1, prefix: '/api', legacy: true };
  }
  return null;
}
