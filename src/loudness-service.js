import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function captureProcessOutput(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args); let output = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { output += chunk; });
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `${command}: код ${code}`)));
    process.on('error', reject);
  });
}

export function parseLoudness(output) {
  const blocks = [...String(output).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)];
  if (!blocks.length) throw new Error('ffmpeg не вернул измерение loudnorm');
  const measured = JSON.parse(blocks.at(-1)[0]);
  const integrated = Number(measured.input_i), peak = Number(measured.input_tp), range = Number(measured.input_lra);
  if (![integrated, peak, range].every(Number.isFinite)) throw new Error('Некорректное измерение громкости');
  const gain = Math.max(-12, Math.min(12, -14 - integrated, -1 - peak));
  return { integrated, peak, range, gain:Math.round(gain * 100) / 100 };
}

export function createLoudnessService({ db, storageDir, execute = captureProcessOutput, startOperation = () => async () => {}, concurrency = 2, logError = console.error }) {
  const storageRoot = path.resolve(storageDir);
  let active = 0;
  const sourcePath = storageKey => {
    if (!storageKey) return null;
    const file = path.resolve(storageRoot, storageKey);
    return file.startsWith(`${storageRoot}${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  };

  async function processNext() {
    if (active >= concurrency) return false;
    active++; let job, finish; let succeeded = false;
    try {
      const result = await db.prepare(`UPDATE loudness_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=(SELECT id FROM loudness_jobs WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`).run();
      job = result.rows[0]; if (!job) return false;
      finish = startOperation('audio.loudness');
      const track = await db.prepare('SELECT storage_key FROM tracks WHERE id=?').get(job.track_id);
      const source = sourcePath(track?.storage_key);
      if (!source) throw new Error('Исходный файл не найден');
      const output = await execute('ffmpeg', ['-hide_banner','-nostats','-i',source,'-map','0:a:0','-af','loudnorm=I=-14:TP=-1:LRA=11:print_format=json','-f','null','-']);
      const value = parseLoudness(output);
      await db.prepare(`UPDATE loudness_jobs SET status='ready',integrated_lufs=?,true_peak_db=?,loudness_range_lu=?,recommended_gain_db=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(value.integrated,value.peak,value.range,value.gain,job.id);
      succeeded = true;
      return true;
    } catch (error) {
      const message = String(error.message || error).slice(-2000), attempts = Number(job?.attempts || 0);
      if (job) await db.prepare(`UPDATE loudness_jobs SET status=?,available_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(attempts >= 3 ? 'failed' : 'retry', Math.min(900, 30 * (2 ** Math.max(0,attempts-1))), message, job.id).catch(()=>{});
      logError('Ошибка анализа громкости:', message);
      return false;
    } finally { await finish?.(succeeded); active--; }
  }

  function pump() {
    for (let slot=0;slot<concurrency;slot++) processNext().catch(error=>logError('Ошибка loudness worker:',error));
  }

  async function recover() {
    await db.prepare("UPDATE loudness_jobs SET status='retry',available_at=CURRENT_TIMESTAMP WHERE status='processing'").run();
    pump();
  }

  async function summary() {
    const [states, values] = await Promise.all([
      db.prepare('SELECT status,count(*) AS count FROM loudness_jobs GROUP BY status').all(),
      db.prepare(`SELECT count(*) AS analyzed,round(avg(integrated_lufs)::numeric,2) AS average_lufs,
        round(min(integrated_lufs)::numeric,2) AS quietest_lufs,round(max(integrated_lufs)::numeric,2) AS loudest_lufs
        FROM loudness_jobs WHERE status='ready'`).get(),
    ]);
    const numberOrNull = value => value == null ? null : Number(value);
    return { states:Object.fromEntries(states.map(item=>[item.status,Number(item.count)])), values:{
      analyzed:Number(values.analyzed),average_lufs:numberOrNull(values.average_lufs),
      quietest_lufs:numberOrNull(values.quietest_lufs),loudest_lufs:numberOrNull(values.loudest_lufs),
    }};
  }

  async function scan() {
    const result = await db.prepare(`INSERT INTO loudness_jobs(track_id,status) SELECT id,'queued' FROM tracks ON CONFLICT(track_id) DO NOTHING`).run();
    pump();
    return Number(result.changes || 0);
  }

  return { processNext, pump, recover, summary, scan };
}

export function createLoudnessHttpController({ loudness, sendJson }) {
  const reply = (res,status,value) => { sendJson(res,status,value); return true; };
  async function handle(req,res,url,user) {
    if (!['/api/admin/loudness','/api/admin/loudness/scan'].includes(url.pathname)) return false;
    if (!user.is_admin) return reply(res,403,{error:'Доступно только администратору'});
    if (url.pathname === '/api/admin/loudness' && req.method === 'GET') return reply(res,200,await loudness.summary());
    if (url.pathname === '/api/admin/loudness/scan' && req.method === 'POST') return reply(res,200,{queued:await loudness.scan()});
    return false;
  }
  return { handle };
}
