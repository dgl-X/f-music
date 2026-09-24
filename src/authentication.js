import { hashPassword, parseCookies, randomToken, tokenHash, verifyPassword } from './security.js';

export function validateInitialSetup(input = {}) {
  const username=String(input.username??'').trim(),displayName=String(input.display_name??'').trim();
  const libraryName=String(input.library_name??'Family Music').trim(),password=String(input.password??'');
  if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))return {error:'Некорректное имя пользователя'};
  if(displayName.length>80)return {error:'Отображаемое имя слишком длинное'};
  if(libraryName.length<2||libraryName.length>60)return {error:'Название библиотеки: от 2 до 60 символов'};
  if(password.length<10||password.length>256)return {error:'Пароль должен содержать от 10 до 256 символов'};
  return {username,displayName:displayName||username,libraryName,password,recognitionEnabled:Boolean(input.recognition_enabled)};
}

export function validateNewPassword(value) {
  const password=String(value??'');
  return password.length>=10&&password.length<=256?{password}:{error:'Новый пароль должен содержать от 10 до 256 символов'};
}

export function requestIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0, 80);
}

export function requestOriginMatches(req, allowMissing = true) {
  const origin = req.headers.origin;
  if (!origin) return allowMissing;
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return origin === `${protocol}://${host}`;
}

export function hasValidSessionOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !parseCookies(req.headers.cookie).music_session) return true;
  return requestOriginMatches(req, false);
}

export function sessionCookie(token, sessionDays, secure) {
  return `music_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 86400}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
  return 'music_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

export class LoginAttemptLimiter {
  constructor({ limit = 8, windowMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }
  blocked(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || now - entry.startedAt > this.windowMs) { this.entries.delete(key); return false; }
    return entry.failures >= this.limit;
  }
  failure(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || now - entry.startedAt > this.windowMs) this.entries.set(key, { failures: 1, startedAt: now });
    else entry.failures++;
  }
  success(key) { this.entries.delete(key); }
}

export function createAuthenticationService({ db, sessionDays, secureCookies }) {
  const attempts = new LoginAttemptLimiter();
  return {
    async setup(input) {
      const values=validateInitialSetup(input);if(values.error)return {status:'invalid',error:values.error};
      const created=await db.transaction(async tx=>{
        await tx.prepare('LOCK TABLE users IN EXCLUSIVE MODE').run();
        if(Number((await tx.prepare('SELECT count(*) count FROM users').get()).count)!==0)return false;
        await tx.prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)').run(values.username,values.displayName,hashPassword(values.password));
        await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('library_name',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(values.libraryName);
        await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('recognition_enabled',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(values.recognitionEnabled?'true':'false');
        return true;
      });
      return created?{status:'ok',libraryName:values.libraryName}:{status:'configured'};
    },
    async login({ username, password, deviceName, clientName, userAgent, ip }) {
      if (attempts.blocked(ip)) return { status: 'blocked' };
      const user = await db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(String(username ?? ''));
      if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
        attempts.failure(ip);
        return { status: 'invalid' };
      }
      attempts.success(ip);
      const token = randomToken();
      const expires = new Date(Date.now() + sessionDays * 86400000);
      const normalizedDevice = String(deviceName ?? '').trim().slice(0, 120) || 'Web-браузер';
      const normalizedClient = String(clientName ?? '').trim().slice(0, 120) || String(userAgent ?? 'Браузер').slice(0, 120);
      await db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at, device_name, client_name, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, tokenHash(token), expires.toISOString(), normalizedDevice, normalizedClient, ip);
      return { status: 'ok', user: { id: user.id, username: user.username, display_name: user.display_name }, cookie: sessionCookie(token, sessionDays, secureCookies) };
    },
    async logout(cookieHeader) {
      const token = parseCookies(cookieHeader).music_session;
      if (token) await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    },
    async currentUser({ cookieHeader, deviceName, clientName, ip }) {
      const token = parseCookies(cookieHeader).music_session;
      if (!token) return null;
      const user = await db.prepare(`SELECT users.id, users.username, users.display_name, users.is_admin, sessions.id AS session_id
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`).get(tokenHash(token)) ?? null;
      if (user) {
        const device = String(deviceName ?? '').trim().slice(0, 120);
        const client = String(clientName ?? '').trim().slice(0, 120);
        await db.prepare(`UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP, ip_address=?,
          device_name=CASE WHEN ?='' THEN device_name ELSE ? END,
          client_name=CASE WHEN ?='' THEN client_name ELSE ? END
          WHERE id=? AND (last_seen_at < CURRENT_TIMESTAMP - INTERVAL '1 minute' OR device_name='' OR device_name='Неизвестное устройство')`)
          .run(ip, device, device, client, client, user.session_id);
      }
      return user;
    },
    async listSessions(user) {
      const items = await db.prepare(`SELECT id, device_name, client_name, ip_address, created_at, last_seen_at, expires_at
        FROM sessions WHERE user_id=? AND expires_at>CURRENT_TIMESTAMP ORDER BY last_seen_at DESC, id DESC`).all(user.id);
      return items.map(item => ({ ...item, id: String(item.id), current: String(item.id) === String(user.session_id) }));
    },
    async revokeOtherSessions(user) {
      return (await db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(user.id, user.session_id)).changes;
    },
    async revokeSession(user, targetId) {
      const target = await db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=?').get(targetId, user.id);
      if (!target) return null;
      await db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(targetId, user.id);
      return { current: String(targetId) === String(user.session_id) };
    },
    async changeOwnPassword({ userId, cookieHeader, currentPassword, newPassword }) {
      const values=validateNewPassword(newPassword);if(values.error)return {status:'invalid',error:values.error};
      const account=await db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
      if(!account||!verifyPassword(String(currentPassword??''),account.password_hash))return {status:'wrong_current'};
      const token=parseCookies(cookieHeader).music_session;
      await db.transaction(async tx=>{
        await tx.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(values.password),userId);
        await tx.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId,tokenHash(token||''));
      });
      return {status:'ok'};
    },
    async resetUserPassword({ targetId, newPassword }) {
      const values=validateNewPassword(newPassword);if(values.error)return {status:'invalid',error:values.error};
      if(!await db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId))return {status:'not_found'};
      await db.transaction(async tx=>{
        await tx.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(values.password),targetId);
        await tx.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
      });
      return {status:'ok'};
    },
  };
}
