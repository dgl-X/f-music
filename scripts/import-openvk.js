import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipExport = args.has('--skip-export');
const config = loadConfig();
const importRoot = path.join(config.dataDir, 'import-openvk');
const filesRoot = path.join(importRoot, 'files');
const manifestPath = path.join(importRoot, 'manifest.tsv');
const filesFromPath = path.join(importRoot, 'files-from.txt');
const reportPath = path.join(importRoot, 'report.json');
const sshHost = process.env.OPENVK_SSH_HOST;
if (!sshHost) throw new Error('OPENVK_SSH_HOST is required');

fs.mkdirSync(importRoot, { recursive: true, mode: 0o750 });

const decodeHex = value => Buffer.from(value || '', 'hex').toString('utf8');
const safeName = value => value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 180) || 'track';
const sourcePath = item => path.join(item.hash.slice(0, 2), `${item.hash}_fragments`, `original_${item.token}.mp3`);

function exportManifest() {
  const query = `SELECT id,HEX(performer),HEX(name),IFNULL(HEX(genre),''),length,created,IFNULL(HEX(lyrics),''),hash,LOWER(HEX(token)) FROM audios WHERE deleted=0 AND withdrawn=0 AND processed=1 ORDER BY id`;
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', sshHost, 'mysql -N -B -r openvk'], { input: query, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Не удалось экспортировать OpenVK manifest: ${result.stderr}`);
  fs.writeFileSync(manifestPath, result.stdout, { mode: 0o640 });
}

function readManifest() {
  return fs.readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const [id, performer, title, genre, length, created, lyrics, hash, token] = line.split('\t');
    if (!/^\d+$/.test(id) || !/^[a-f0-9]{128}$/i.test(hash) || !/^[a-f0-9]{56}$/i.test(token)) throw new Error(`Некорректная строка manifest для audio ${id}`);
    return { id, artist: decodeHex(performer), title: decodeHex(title), genre: decodeHex(genre), duration: Number(length), created: Number(created), lyrics: decodeHex(lyrics), hash: hash.toLowerCase(), token: token.toLowerCase() };
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function inspect(file) {
  const result = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return {};
  try { const tags = JSON.parse(result.stdout).format?.tags ?? {}; return Object.fromEntries(Object.entries(tags).map(([key,value]) => [key.toLowerCase(), String(value)])); } catch { return {}; }
}

function extractCover(source, destination) {
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-loglevel','error','-y','-i',source,'-map','0:v:0','-frames:v','1','-vf',"scale='min(1000,iw)':'min(1000,ih)':force_original_aspect_ratio=decrease",'-q:v','3',destination], { stdio:'ignore' });
    proc.on('close', code => resolve(code === 0)); proc.on('error', () => resolve(false));
  });
}

if (!skipExport) exportManifest();
const items = readManifest();
fs.writeFileSync(filesFromPath, items.map(sourcePath).join('\n') + '\n', { mode: 0o640 });

if (dryRun) {
  const summary = { mode:'dry-run', source:sshHost, tracks:items.length, duration_hours:Number((items.reduce((sum,item)=>sum+item.duration,0)/3600).toFixed(2)), with_lyrics:items.filter(item=>item.lyrics).length, files_from:filesFromPath };
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2) + '\n', { mode:0o640 });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const db = openDatabase(config.dataDir);
const owner = db.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get();
if (!owner) throw new Error('В Family Music не найден администратор');
fs.mkdirSync(path.join(config.storageDir,'originals'), { recursive:true, mode:0o750 });
fs.mkdirSync(path.join(config.storageDir,'covers'), { recursive:true, mode:0o750 });
const report = { mode:'import', source:sshHost, manifest:items.length, imported:0, deduplicated:0, already_imported:0, failed:[] };

for (const [position,item] of items.entries()) {
  const mapped = db.prepare("SELECT track_id FROM track_sources WHERE source='openvk' AND source_id=?").get(item.id);
  if (mapped) { report.already_imported++; continue; }
  const source = path.join(filesRoot, sourcePath(item));
  if (!fs.existsSync(source)) { report.failed.push({ id:item.id, error:'source file missing' }); continue; }
  try {
    const sha256 = await sha256File(source);
    const existing = db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sha256);
    if (existing) {
      db.transaction(() => {
        if (item.lyrics) db.prepare("UPDATE tracks SET lyrics=COALESCE(lyrics,?) WHERE id=?").run(item.lyrics, existing.id);
        db.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('openvk',?,?)").run(item.id, existing.id);
      })();
      report.deduplicated++; continue;
    }
    const trackId = crypto.randomUUID();
    const shard = trackId.slice(0,2);
    const originalKey = path.join('originals',shard,`${trackId}.mp3`);
    const original = path.join(config.storageDir,originalKey);
    fs.mkdirSync(path.dirname(original), { recursive:true, mode:0o750 });
    fs.copyFileSync(source, original, fs.constants.COPYFILE_EXCL);
    const coverKey = path.join('covers',shard,`${trackId}.jpg`);
    const cover = path.join(config.storageDir,coverKey);
    fs.mkdirSync(path.dirname(cover), { recursive:true, mode:0o750 });
    const hasCover = await extractCover(source,cover);
    if (!hasCover) fs.rmSync(cover,{force:true});
    const tags = inspect(source);
    const year = Number.parseInt(tags.date || tags.year || '',10) || null;
    const createdAt = new Date(item.created*1000).toISOString().replace('T',' ').replace('Z','');
    const filename = `${safeName(item.artist)} — ${safeName(item.title)}.mp3`;
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key,sha256,cover_key,cover_checked,genre,lyrics,year,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(trackId,owner.id,item.title,item.artist,'',filename,'audio/mpeg',fs.statSync(original).size,item.duration,originalKey,sha256,hasCover?coverKey:null,item.genre,item.lyrics||null,year,createdAt);
        db.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('openvk',?,?)").run(item.id,trackId);
      })();
    } catch (error) { fs.rmSync(original,{force:true}); if(hasCover)fs.rmSync(cover,{force:true}); throw error; }
    report.imported++;
    if ((position+1)%20===0) console.log(`Обработано ${position+1}/${items.length}`);
  } catch (error) { report.failed.push({id:item.id,error:error.message}); }
}
db.close();
fs.writeFileSync(reportPath, JSON.stringify(report,null,2)+'\n',{mode:0o640});
console.log(JSON.stringify(report,null,2));
if(report.failed.length)process.exitCode=2;
