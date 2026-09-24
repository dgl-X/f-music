import fs from 'node:fs';
import path from 'node:path';

export function resolveStoredMedia(storageDir, storageKey) {
  const root = path.resolve(storageDir);
  const file = path.resolve(root, String(storageKey || ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

export function parseByteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start = 0, end = size - 1;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
  } else {
    start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end, status: 206 };
}

export function serveStoredMedia(req, res, { storageDir, storageKey, mimeType, variant = 'original', xAccelRedirect = false }) {
  const file = resolveStoredMedia(storageDir, storageKey);
  if (!file) return false;
  const common = { 'Content-Type': mimeType || 'application/octet-stream', 'X-Music-Variant': variant, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' };
  if (xAccelRedirect) {
    const internalPath = '/_protected_media/' + String(storageKey).split('/').map(encodeURIComponent).join('/');
    res.writeHead(200, { ...common, 'X-Accel-Redirect': internalPath });
    res.end();
    return true;
  }
  const size = fs.statSync(file).size;
  const range = parseByteRange(req.headers.range, size);
  if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true; }
  res.writeHead(range.status, { ...common, 'Content-Length': range.end - range.start + 1, ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
  fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  return true;
}
