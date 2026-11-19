// Fixed-origin local diagnostic, never an application transport.
import { connect } from 'cloudflare:sockets';
import { isIP } from 'node:net';

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (env.MAPI_LOCAL_TEST !== '1' || url.hostname !== '127.0.0.1' || request.method !== 'POST') return new Response(null, { status: 404 });
  if (isIP(env.MAPI_SOCKET_TEST_IP ?? '') !== 4) return new Response(null, { status: 400 });
  const mode = url.searchParams.get('mode');
  if (!['hostname', 'ip'].includes(mode)) return new Response(null, { status: 400 });
  const socket = connect({ hostname: mode === 'hostname' ? 'www.google.com' : env.MAPI_SOCKET_TEST_IP, port: 443 }, { secureTransport: 'on' });
  socket.closed.catch(() => {});
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 5000); });
    const info = await Promise.race([socket.opened, timeout]);
    const remoteAddress = info.remoteAddress ?? null;
    let remoteHost = remoteAddress;
    try { if (typeof remoteHost === 'string' && !isIP(remoteHost)) remoteHost = new URL(`http://${remoteHost}`).hostname.replace(/^\[|\]$/g, ''); } catch { remoteHost = null; }
    return Response.json({ opened: true, remoteAddress, numericPeer: typeof remoteHost === 'string' && isIP(remoteHost) !== 0 });
  } catch (error) {
    return Response.json({ opened: false, message: String(error.message).slice(0, 300), remoteAddress: null, numericPeer: false });
  } finally {
    clearTimeout(timer);
    await socket.close().catch(() => {});
  }
} };
