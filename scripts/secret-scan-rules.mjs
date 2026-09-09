export const publishedTestVectors = new Set([
  'federation/vectors/http-signature-ed25519-v1.json',
]);

export const secretPatterns = [
  ['приватный ключ', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['секрет в присваивании', /(?:api[_-]?secret|bearer[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{20,}/i],
];

export function localForbiddenTerms(filename = process.env.MUSIC_SECRET_SCAN_TERMS_FILE) {
  if (!filename) return [];
  return filename;
}

