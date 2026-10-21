import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runMediaProcess } from './media-process.js';

export async function inspectAudio(file, options = {}) {
  const result = await runMediaProcess('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs:30000, ...options });
  // Resource/tool failure is not proof of invalid audio: allow job retry rather
  // than letting upload validation delete a potentially valid original.
  if (result.error) throw Object.assign(new Error(`Не удалось проверить аудио: ${result.error}`), { code:`media_${result.error}` });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.format ? { ...parsed.format, streams:parsed.streams ?? [] } : null;
  } catch { return null; }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function runProcess(command, args, options) {
  return (await runMediaProcess(command, args, options)).code === 0;
}

export function createCoverExtractor({ coverDir, storageDir, execute = runProcess }) {
  return async function extractCover(file, trackId) {
    const shard = trackId.slice(0, 2);
    const destinationDir = path.join(coverDir, shard);
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o750 });
    const coverKey = path.join('covers', shard, `${trackId}.jpg`);
    const destination = path.join(storageDir, coverKey);
    const ok = await execute('ffmpeg', [
      '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-frames:v', '1',
      '-vf', "scale='min(1000,iw)':'min(1000,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', destination,
    ]);
    if (!ok) { fs.rmSync(destination, { force: true }); return null; }
    return coverKey;
  };
}
