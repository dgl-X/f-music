import { clearSessionCookie } from './authentication.js';
import { hashPassword } from './security.js';

const SESSION_PATH = /^\/api\/sessions\/(\d+)$/;
const USER_PASSWORD_PATH = /^\/api\/users\/(\d+)\/password$/;

export function createAccountHttpController({ db, authentication, registrationEnabled, readJson, sendJson }) {
  async function handle(req, res, url, user) {
    if (url.pathname === '/api/me') {
      sendJson(res, 200, user);
      return true;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      sendJson(res, 200, { items:await authentication.listSessions(user) });
      return true;
    }
    if (url.pathname === '/api/sessions/others' && req.method === 'DELETE') {
      sendJson(res, 200, { ok:true, revoked:await authentication.revokeOtherSessions(user) });
      return true;
    }
    const session = SESSION_PATH.exec(url.pathname);
    if (session && req.method === 'DELETE') {
      const result = await authentication.revokeSession(user, session[1]);
      if (!result) sendJson(res, 404, { error:'Сессия не найдена' });
      else sendJson(res, 200, { ok:true, current:result.current }, result.current ? { 'Set-Cookie':clearSessionCookie() } : {});
      return true;
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else sendJson(res, 200, { items:await db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at, id').all() });
      return true;
    }
    if (url.pathname === '/api/admin/registration-settings' && req.method === 'GET') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else sendJson(res, 200, { enabled:await registrationEnabled() });
      return true;
    }
    if (url.pathname === '/api/admin/registration-settings' && req.method === 'PUT') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else {
        const enabled = Boolean((await readJson(req)).enabled);
        await db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('registration_enabled',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled ? 'true' : 'false');
        sendJson(res, 200, { enabled });
      }
      return true;
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      if (!user.is_admin) {
        sendJson(res, 403, { error:'Доступно только администратору' });
        return true;
      }
      const body = await readJson(req);
      const username = String(body.username ?? '').trim();
      const displayName = String(body.display_name ?? '').trim();
      const password = String(body.password ?? '');
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) sendJson(res, 400, { error:'Логин: 3–32 символа, латиница, цифры, ., _ и -' });
      else if (displayName.length > 80) sendJson(res, 400, { error:'Отображаемое имя слишком длинное' });
      else if (password.length < 10) sendJson(res, 400, { error:'Пароль должен содержать не менее 10 символов' });
      else if (await db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(username)) sendJson(res, 409, { error:'Такой логин уже занят' });
      else {
        const result = await db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0) RETURNING id')
          .run(username, displayName || username, hashPassword(password));
        sendJson(res, 201, { id:Number(result.rows[0].id), username, display_name:displayName || username, is_admin:0 });
      }
      return true;
    }
    if (url.pathname === '/api/me/password' && req.method === 'PUT') {
      const body = await readJson(req);
      const result = await authentication.changeOwnPassword({ userId:user.id, cookieHeader:req.headers.cookie, currentPassword:body.current_password, newPassword:body.new_password });
      if (result.status === 'wrong_current') sendJson(res, 400, { error:'Текущий пароль указан неверно' });
      else if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
      else sendJson(res, 200, { ok:true });
      return true;
    }
    const password = USER_PASSWORD_PATH.exec(url.pathname);
    if (password && req.method === 'PUT') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else {
        const targetId = Number(password[1]);
        if (targetId === user.id) sendJson(res, 400, { error:'Свой пароль меняется через профиль' });
        else {
          const result = await authentication.resetUserPassword({ targetId, newPassword:(await readJson(req)).new_password });
          if (result.status === 'not_found') sendJson(res, 404, { error:'Пользователь не найден' });
          else if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
          else sendJson(res, 200, { ok:true });
        }
      }
      return true;
    }
    return false;
  }

  return { handle };
}
