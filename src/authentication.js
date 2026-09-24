import { parseCookies, randomToken, tokenHash, verifyPassword } from './security.js';

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
  };
}
