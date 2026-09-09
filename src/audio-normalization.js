import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export function hybridFlacMediaOffset(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const marker = Buffer.alloc(4);
    if (fs.readSync(descriptor, marker, 0, 4, 0) !== 4 || marker.toString() !== 'fLaC') return null;
    let offset = 4;
    let last = false;
    while (!last) {
      const header = Buffer.alloc(4);
      if (fs.readSync(descriptor, header, 0, 4, offset) !== 4) return null;
      last = Boolean(header[0] & 0x80);
      offset += 4 + header.readUIntBE(1, 3);
      if (offset > fs.fstatSync(descriptor).size - 8) return null;
    }
    const mediaHeader = Buffer.alloc(8);
    if (fs.readSync(descriptor, mediaHeader, 0, 8, offset) !== 8) return null;
    return mediaHeader.subarray(4).toString() === 'ftyp' ? offset : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} завершился с кодом ${code}`)));
  });
}

export async function normalizeHybridFlac(filename) {
  const offset = hybridFlacMediaOffset(filename);
  if (offset === null) return { normalized: false };
  const suffix = `.normalize-${crypto.randomUUID()}`;
  const media = `${filename}${suffix}.m4a`;
  const output = `${filename}${suffix}.flac`;
  try {
    await pipeline(fs.createReadStream(filename, { start: offset }), fs.createWriteStream(media, { mode: 0o640 }));
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', media, '-map', '0:a:0', '-c:a', 'copy', '-f', 'flac', '-y', output]);
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-map', '0:a:0', '-f', 'null', '-']);
    return { normalized: true, output, offset };
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  } finally {
    fs.rmSync(media, { force: true });
  }
}

