// Loopback-only local proof; never route application or tenant input here.
import { connect } from 'node:tls';
import { isIP } from 'node:net';

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (env.MAPI_LOCAL_TEST !== '1' || url.hostname !== '127.0.0.1' || request.method !== 'POST') return new Response(null, { status: 404 });
  const name = url.searchParams.get('name');
  if (!['www.google.com', 'wrong.invalid'].includes(name) || isIP(env.MAPI_TLS_TEST_IP ?? '') !== 4 || !/^\d+$/.test(env.MAPI_TLS_TEST_PORT ?? '')) return new Response(null, { status: 400 });
  const port = Number(env.MAPI_TLS_TEST_PORT);
  if (port < 1 || port > 65535) return new Response(null, { status: 400 });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(Response.json(value)); };
    const socket = connect({ host: env.MAPI_TLS_TEST_MODE === 'hostname' ? 'www.google.com' : env.MAPI_TLS_TEST_IP, port, servername: name, rejectUnauthorized: true }, () => {
      if (!socket.authorized) return finish({ ok: false, phase: 'unauthorized' });
      return finish({ ok: true, phase: 'authorized', remoteAddress: socket.remoteAddress ?? null, servernameReported: socket.servername ?? null });
    });
    const timer = setTimeout(() => finish({ ok: false, phase: 'timeout' }), 4000);
    socket.on('error', (error) => finish({ ok: false, phase: 'tls', code: error.code ?? null, message: String(error.message).slice(0, 300) }));
  });
} };
