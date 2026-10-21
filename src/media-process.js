import { spawn } from 'node:child_process';
import path from 'node:path';

const children = new Set();
// Controlled fail-stop (including loss of a queue lock) also terminates media.
process.once('exit',()=>{for(const child of children)child.kill('SIGKILL');});

// Media is already local. Demuxers must not fetch nested HTTP/FTP resources.
export function localMediaArgs(command, args) {
  const name = path.basename(command);
  if (name !== 'ffmpeg' && name !== 'ffprobe') return [...args];
  if (name === 'ffprobe') return ['-protocol_whitelist', 'file,pipe', ...args];
  return ['-nostdin', ...args.flatMap(arg => arg === '-i' ? ['-protocol_whitelist', 'file,pipe', '-i'] : [arg])];
}

export function runMediaProcess(command, args, { timeoutMs = 15 * 60 * 1000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, localMediaArgs(command, args), { stdio:['ignore','pipe','pipe'] }); }
    catch { resolve({ code:null, stdout:'', stderr:'', error:'spawn_failed' }); return; }
    children.add(child);
    let size = 0, error = null, finished = false;
    const stdout = [], stderr = [];
    const stop = reason => {
      if (error || finished) return;
      error = reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = target => chunk => {
      if (error || finished) return;
      size += chunk.length;
      if (size > maxOutputBytes) { stop('output_limit'); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => { error ||= 'spawn_failed'; });
    // Wait for close, not only kill(): consumers may now safely clean temporary files.
    child.once('close', code => {
      children.delete(child);
      finished = true;
      clearTimeout(timer);
      resolve({ code:error ? null : code, stdout:Buffer.concat(stdout).toString('utf8'), stderr:Buffer.concat(stderr).toString('utf8'), error });
    });
  });
}

export async function captureMediaOutput(command, args, options) {
  const result = await runMediaProcess(command, args, options);
  if (result.code !== 0) throw Object.assign(new Error(`Медиапроцесс завершился с ошибкой: ${result.error || result.code}`), { code:result.error || 'media_process_failed' });
  return result.stdout + result.stderr;
}
