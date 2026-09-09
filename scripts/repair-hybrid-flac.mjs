import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hybridFlacMediaOffset, normalizeHybridFlac } from '../src/audio-normalization.js';

const apply = process.argv.includes('--apply');
const jobsArgument = process.argv.find(value => value.startsWith('--jobs='));
const jobs = Math.max(1, Math.min(32, Number(jobsArgument?.split('=')[1]) || 1));
const config = loadConfig();
const db = await openDatabase(config.databaseUrl);
const tracks = await db.prepare("SELECT id,storage_key FROM tracks WHERE mime_type='audio/flac' ORDER BY created_at").all();
const affected = tracks.filter(track => hybridFlacMediaOffset(path.resolve(config.storageDir, track.storage_key)) !== null);
const backupRoot = path.join(config.storageDir, 'maintenance-backups', `hybrid-flac-${new Date().toISOString().slice(0, 10)}`);
let cursor = 0;
let repaired = 0;
let failed = 0;

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function repair(track) {
  const original = path.resolve(config.storageDir, track.storage_key);
  const backup = path.join(backupRoot, track.storage_key);
  const result = await normalizeHybridFlac(original);
  if (!result.normalized) return;
  try {
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o750 });
    fs.renameSync(original, backup);
    fs.renameSync(result.output, original);
    fs.chownSync(original, fs.statSync(backup).uid, fs.statSync(backup).gid);
    fs.chmodSync(original, 0o640);
    const stat = fs.statSync(original);
    const sha256 = await sha256File(original);
    await db.prepare('UPDATE tracks SET size_bytes=?,sha256=? WHERE id=?').run(stat.size, sha256, track.id);
    repaired++;
    console.log(`OK ${repaired + failed}/${affected.length} ${track.id}`);
  } catch (error) {
    if (!fs.existsSync(original) && fs.existsSync(backup)) fs.renameSync(backup, original);
    fs.rmSync(result.output, { force: true });
    throw error;
  }
}

async function worker() {
  while (cursor < affected.length) {
    const track = affected[cursor++];
    try { await repair(track); }
    catch (error) { failed++; console.error(`ERROR ${track.id}: ${error.message}`); }
  }
}

console.log(JSON.stringify({ scanned: tracks.length, affected: affected.length, apply, jobs }));
if (apply) await Promise.all(Array.from({ length: jobs }, () => worker()));
console.log(JSON.stringify({ affected: affected.length, repaired, failed, backup: apply ? backupRoot : null }));
await db.close?.();
if (failed) process.exitCode = 1;

