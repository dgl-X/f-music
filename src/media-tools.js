import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function inspectAudio(file) {
  return new Promise(resolve => {
    const process = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let output = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.on('close', code => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(output);
        resolve(parsed.format ? { ...parsed.format, streams: parsed.streams ?? [] } : null);
      } catch { resolve(null); }
    });
    process.on('error', () => resolve(null));
  });
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

export function runProcess(command, args) {
  return new Promise(resolve => {
    const process = spawn(command, args, { stdio: 'ignore' });
    process.on('close', code => resolve(code === 0));
    process.on('error', () => resolve(false));
  });
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
