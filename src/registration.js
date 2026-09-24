export function validateRegistration(input = {}) {
  const username = String(input.username ?? '').trim();
  const displayName = String(input.display_name ?? '').trim();
  const password = String(input.password ?? '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return { error: 'Логин: от 3 до 32 латинских букв, цифр или символов _.-' };
  if (displayName.length > 80) return { error: 'Отображаемое имя слишком длинное' };
  if (password.length < 10 || password.length > 256) return { error: 'Пароль должен содержать от 10 до 256 символов' };
  return { username, displayName: displayName || username, password };
}

export class RegistrationLimiter {
  constructor({ limit = 5, windowMs = 60 * 60 * 1000 } = {}) { this.limit=limit;this.windowMs=windowMs;this.entries=new Map(); }
  take(key, now=Date.now()) {
    const current=this.entries.get(key);
    if(!current||now-current.startedAt>=this.windowMs){this.entries.set(key,{count:1,startedAt:now});return true;}
    if(current.count>=this.limit)return false;
    current.count++;return true;
  }
}
