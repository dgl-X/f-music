import fs from 'node:fs';
import path from 'node:path';

export function parseRequestUrl(req) {
  try { return new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { throw Object.assign(new Error('Некорректный адрес запроса'), { status:400 }); }
}

export async function readJson(req, limit = 64 * 1024) {
  const data = await readBytesInternal(req, limit, 'Слишком большой запрос', true);
  try { return JSON.parse(data.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Некорректный JSON'), { status:400 }); }
}

export async function readBytes(req, limit) {
  return readBytesInternal(req, limit, 'Файл слишком большой', false);
}

async function readBytesInternal(req, limit, sizeMessage, allowEmpty) {
  const declared = Number(req.headers?.['content-length'] ?? 0);
  if (declared > limit) throw Object.assign(new Error(sizeMessage), { status:413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(sizeMessage), { status:413 });
    chunks.push(chunk);
  }
  if (!size && !allowEmpty) throw Object.assign(new Error('Пустой файл'), { status:400 });
  return Buffer.concat(chunks);
}

export function createUserAccess({ authentication, parseCookies, requestIp, sessionCookie, sessionDays, secureCookies, sendJson }) {
  async function currentUser(req) {
    return authentication.currentUser({
      cookieHeader:req.headers.cookie,
      deviceName:req.headers['x-device-name'],
      clientName:req.headers['x-client-name'],
      ip:requestIp(req),
    });
  }
  async function requireUser(req, res) {
    const user = await currentUser(req);
    if (!user) sendJson(res, 401, { error:'Требуется авторизация' });
    else {
      const token = parseCookies(req.headers.cookie).music_session;
      if (token) res.setHeader('Set-Cookie', sessionCookie(token, sessionDays, secureCookies));
    }
    return user;
  }
  return { currentUser, requireUser };
}

export function createStaticFileHandler(publicDir) {
  const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
  return function staticFile(res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    res.writeHead(200, { 'Content-Type':types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-cache' });
    fs.createReadStream(file).pipe(res);
    return true;
  };
}

export function setBrowserSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwardedProto === 'https' || req.socket?.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
