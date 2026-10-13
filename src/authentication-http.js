import { clearSessionCookie, requestIp, requestOriginMatches } from './authentication.js';
import { RegistrationLimiter, validateRegistration } from './registration.js';
import { hashPassword } from './security.js';

export function createAuthenticationHttpController({ db, authentication, registrationEnabled, readJson, sendJson, registrationLimiter = new RegistrationLimiter() }) {
  async function handle(req, res, url) {
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      const result = await authentication.setup(await readJson(req));
      if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
      else if (result.status === 'configured') sendJson(res, 409, { error:'Первичная настройка уже выполнена' });
      else sendJson(res, 201, { ok:true, library_name:result.libraryName });
      return true;
    }
    if (url.pathname === '/api/register' && req.method === 'POST') {
      if (!requestOriginMatches(req)) {
        sendJson(res, 403, { error:'Недоверенный источник запроса' });
        return true;
      }
      if (!await registrationEnabled()) {
        sendJson(res, 404, { error:'Регистрация отключена' });
        return true;
      }
      if (Number((await db.prepare('SELECT count(*) count FROM users').get()).count) === 0) {
        sendJson(res, 409, { error:'Сначала выполните первоначальную настройку сервера' });
        return true;
      }
      const ip = requestIp(req);
      if (!registrationLimiter.take(ip)) {
        sendJson(res, 429, { error:'Слишком много регистраций. Повторите позже' }, { 'Retry-After':'3600' });
        return true;
      }
      const values = validateRegistration(await readJson(req));
      if (values.error) {
        sendJson(res, 400, { error:values.error });
        return true;
      }
      try {
        const result = await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,0) RETURNING id')
          .run(values.username, values.displayName, hashPassword(values.password));
        sendJson(res, 201, { id:Number(result.rows[0].id), username:values.username, display_name:values.displayName });
      } catch (error) {
        if (error.code !== '23505') throw error;
        sendJson(res, 409, { error:'Такой логин уже занят' });
      }
      return true;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await authentication.login({
        username:body.username,
        password:body.password,
        deviceName:body.device_name,
        clientName:body.client_name,
        userAgent:req.headers['user-agent'],
        ip:requestIp(req),
      });
      if (result.status === 'blocked') sendJson(res, 429, { error:'Слишком много попыток. Повторите позже' }, { 'Retry-After':'900' });
      else if (result.status === 'invalid') sendJson(res, 401, { error:'Неверное имя пользователя или пароль' });
      else sendJson(res, 200, result.user, { 'Set-Cookie':result.cookie });
      return true;
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      await authentication.logout(req.headers.cookie);
      sendJson(res, 200, { ok:true }, { 'Set-Cookie':clearSessionCookie() });
      return true;
    }
    return false;
  }

  return { handle };
}
