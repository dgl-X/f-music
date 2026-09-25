import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseContentRange } from './security.js';

export function sanitizeUploadFilename(name) {
  return path.basename(String(name ?? '')).replace(/[\x00-\x1f]/g, '').slice(0, 240);
}

export function validateUploadCreation(input, maxUploadBytes) {
  const filename = sanitizeUploadFilename(input?.filename);
  const totalBytes = Number(input?.size);
  if (!filename || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maxUploadBytes) return null;
  return {
    filename,
    totalBytes,
    mimeType: String(input?.mime_type || 'application/octet-stream').slice(0, 255),
  };
}

export function validateUploadPart({ contentRange, contentLength, upload }) {
  const range = parseContentRange(contentRange);
  if (!range || range.total !== upload.total_bytes || range.start !== upload.received_bytes) {
    return { status: 'offset_mismatch', expectedOffset: upload.received_bytes };
  }
  if (Number(contentLength) !== range.length) return { status: 'length_mismatch' };
  return { status: 'ok', range };
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += (await handle.write(buffer, offset)).bytesWritten;
}

export function createUploadService({ db, uploadDir, maxUploadBytes, uploadJobs }) {
  const activeWrites = new Set();

  async function list({ userId }) {
    const items = (await db.prepare(`SELECT id,filename,mime_type,total_bytes,received_bytes,status,error,track_id,created_at,updated_at
      FROM uploads WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`).all(userId)).map(upload => ({
      ...upload, total_bytes: Number(upload.total_bytes), received_bytes: Number(upload.received_bytes),
    }));
    return { items };
  }

  async function create({ userId, input }) {
    const validated = validateUploadCreation(input, maxUploadBytes);
    if (!validated) return { status: 'invalid' };
    const id = crypto.randomUUID();
    const temporary = path.join(uploadDir, `${id}.part`);
    await db.prepare('INSERT INTO uploads (id,user_id,filename,mime_type,total_bytes) VALUES (?,?,?,?,?)')
      .run(id, userId, validated.filename, validated.mimeType, validated.totalBytes);
    try {
      fs.closeSync(fs.openSync(temporary, 'wx', 0o640));
    } catch (error) {
      await db.prepare('DELETE FROM uploads WHERE id=? AND user_id=?').run(id, userId);
      throw error;
    }
    return { status: 'ok', id, offset: 0, size: validated.totalBytes };
  }

  async function get({ userId, uploadId }) {
    const upload = await db.prepare('SELECT * FROM uploads WHERE id=? AND user_id=?').get(uploadId, userId);
    if (!upload) return null;
    return { ...upload, received_bytes: Number(upload.received_bytes), total_bytes: Number(upload.total_bytes) };
  }

  async function writePart({ upload, contentRange, contentLength, chunks }) {
    if (upload.status !== 'uploading') return { status: 'complete' };
    if (activeWrites.has(upload.id)) return { status: 'busy', expectedOffset: upload.received_bytes };
    const validation = validateUploadPart({ contentRange, contentLength, upload });
    if (validation.status !== 'ok') return validation;
    activeWrites.add(upload.id);
    const chunkPath = path.join(uploadDir, `.${upload.id}-${crypto.randomUUID()}.chunk`);
    let handle;
    try {
      handle = await fs.promises.open(chunkPath, 'wx', 0o640);
      let written = 0;
      for await (const chunk of chunks) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (written + buffer.length > validation.range.length) return { status: 'too_large' };
        await writeAll(handle, buffer);
        written += buffer.length;
      }
      await handle.close(); handle = null;
      if (written !== validation.range.length) return { status: 'incomplete' };
      const target = path.join(uploadDir, `${upload.id}.part`);
      await pipeline(fs.createReadStream(chunkPath), fs.createWriteStream(target, { flags: 'r+', start: validation.range.start }));
      const next = validation.range.end + 1;
      await db.prepare('UPDATE uploads SET received_bytes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, upload.id);
      if (next === upload.total_bytes) {
        await uploadJobs.enqueue({ uploadId: upload.id, candidateTrackId: crypto.randomUUID() });
        return { status: 'accepted', offset: next, complete: true, processing: true };
      }
      return { status: 'ok', offset: next, complete: false };
    } finally {
      if (handle) await handle.close().catch(() => {});
      fs.rmSync(chunkPath, { force: true });
      activeWrites.delete(upload.id);
    }
  }

  return { list, create, get, writePart };
}
