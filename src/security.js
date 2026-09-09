import crypto from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Пароль должен содержать не менее 10 символов');
  }
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltText, hashText] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const pos = v.indexOf('=');
    return pos < 0 ? [v, ''] : [v.slice(0, pos), decodeURIComponent(v.slice(pos + 1))];
  }));
}

export function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start < 0 || end < start || end >= total) return null;
  return { start, end, total, length: end - start + 1 };
}

export function acquireCounter(counter, key, limit) {
  const count = counter.get(key) || 0;
  if (count >= limit) return false;
  counter.set(key, count + 1);
  return true;
}

export function releaseCounter(counter, key) {
  const count = counter.get(key) || 0;
  if (count <= 1) counter.delete(key);
  else counter.set(key, count - 1);
}
