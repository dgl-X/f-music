import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/db.js';

const databaseUrl = process.env.MEDIA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('MEDIA_TEST_DATABASE_URL is required');

const port = Number(process.env.MEDIA_TEST_PORT || 18095);
const origin = `http://127.0.0.1:${port}`;
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-media-test-'));
const children = [];
const accountSecret = ['integration', 'fixture', String(process.pid)].join('-');
const changedCredential = ['integration', 'changed', String(process.pid)].join('-');
const familyCredential = ['family', 'changed', String(process.pid)].join('-');

function wavFixture() {
  const sampleRate = 8000, seconds = 1, samples = sampleRate * seconds;
  const dataSize = samples * 2, bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 8000), 44 + index * 2);
  return bytes;
}

function start(role) {
  const child = spawn(process.execPath, ['src/server.js', ...(role === 'worker' ? ['--worker'] : [])], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MUSIC_HOST: '127.0.0.1',
      MUSIC_PORT: String(port),
      MUSIC_STORAGE_DIR: storageDir,
      MUSIC_WORKER_POLL_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); children.push(child);
  return child;
}

async function waitFor(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(message);
}

async function json(pathname, options = {}) {
  const response = await fetch(origin + pathname, options);
  const body = await response.json();
  return { response, body };
}

let db;
try {
  start('api');
  await waitFor(async () => (await fetch(`${origin}/api/v1/health`)).ok, 'API did not start');
  db = await openDatabase(databaseUrl);

  let result = await json('/api/v1/setup/status');
  assert.equal(result.body.needs_setup, true);
  assert.equal(result.body.checks.database, 'ok');
  assert.equal(result.body.checks.storage, 'ok');

  result = await json('/api/v1/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration', display_name: 'Integration', password: accountSecret, library_name: 'Integration Music', recognition_enabled: false }),
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.library_name, 'Integration Music');
  result = await json('/api/v1/setup/status');
  assert.equal(result.body.needs_setup, false);
  assert.equal(result.body.library_name, 'Integration Music');
  assert.equal(result.body.registration_enabled, false);
  result = await json('/api/v1/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'family', display_name: 'Family', password: accountSecret }),
  });
  assert.equal(result.response.status, 404);
  result = await json('/api/v1/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'secondadmin', display_name: 'Second', password: accountSecret, library_name: 'Changed Music' }),
  });
  assert.equal(result.response.status, 409);
  result = await json('/api/v1/setup/status');
  assert.equal(result.body.library_name, 'Integration Music');

  result = await json('/api/v1/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration', password: accountSecret }),
  });
  assert.equal(result.response.status, 200);
  const cookie = result.response.headers.get('set-cookie').split(';', 1)[0];

  result = await json('/api/v1/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration', password: accountSecret, device_name: 'Second integration device' }),
  });
  assert.equal(result.response.status, 200);
  const secondCookie = result.response.headers.get('set-cookie').split(';', 1)[0];
  result = await json('/api/v1/sessions', { headers: { Cookie: cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.items.length, 2);
  const secondSession = result.body.items.find(item => !item.current);
  result = await json(`/api/v1/sessions/${secondSession.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(result.response.status, 403);
  result = await json(`/api/v1/sessions/${secondSession.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin } });
  assert.equal(result.response.status, 200);
  result = await json('/api/v1/me', { headers: { Cookie: secondCookie } });
  assert.equal(result.response.status, 401);

  result = await json('/api/v1/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'integration', password: accountSecret, device_name: 'Expiring integration device' }),
  });
  assert.equal(result.response.status, 200);
  const expiringCookie = result.response.headers.get('set-cookie').split(';', 1)[0];
  await db.prepare("UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE device_name=?").run('Expiring integration device');
  result = await json('/api/v1/me', { headers: { Cookie: expiringCookie } });
  assert.equal(result.response.status, 401);

  result = await json('/api/v1/admin/registration-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify({ enabled:true }),
  });
  assert.equal(result.response.status, 200);
  result = await json('/api/v1/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'family', display_name: 'Family', password: accountSecret }),
  });
  assert.equal(result.response.status, 201);
  const familyId=result.body.id;
  result = await json('/api/v1/admin/registration-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify({ enabled:false }),
  });
  assert.equal(result.response.status, 200);

  const audio = wavFixture();

  result = await json('/api/v1/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ filename: 'integration.wav', mime_type: 'audio/wav', size: audio.length }),
  });
  assert.equal(result.response.status, 201);
  const uploadId = result.body.id, split = Math.floor(audio.length / 2);

  result = await json(`/api/v1/uploads/${uploadId}`, {
    method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 1-${split}/${audio.length}` },
    body: audio.subarray(0, split),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.expected_offset, 0);

  for (const [startOffset, endOffset] of [[0, split - 1], [split, audio.length - 1]]) {
    result = await json(`/api/v1/uploads/${uploadId}`, {
      method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${startOffset}-${endOffset}/${audio.length}` },
      body: audio.subarray(startOffset, endOffset + 1),
    });
    assert.ok([200, 202].includes(result.response.status));
    assert.equal(result.body.offset, endOffset + 1);
  }

  await db.prepare("UPDATE processing_jobs SET status='processing',started_at=CURRENT_TIMESTAMP WHERE upload_id=?").run(uploadId);
  start('worker');
  const ready = await waitFor(async () => {
    const status = await json(`/api/v1/uploads/${uploadId}`, { headers: { Cookie: cookie } });
    return status.body.status === 'ready' ? status.body : null;
  }, 'Worker did not recover and finish the upload', 30000);
  assert.ok(ready.track_id);

  const invalidAudio=Buffer.from('this is not an mp3 stream');
  result=await json('/api/v1/uploads',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify({filename:'broken.mp3',mime_type:'audio/mpeg',size:invalidAudio.length})});
  assert.equal(result.response.status,201);const invalidUploadId=result.body.id;
  result=await json(`/api/v1/uploads/${invalidUploadId}`,{method:'PUT',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/octet-stream','Content-Range':`bytes 0-${invalidAudio.length-1}/${invalidAudio.length}`},body:invalidAudio});
  assert.ok([200,202].includes(result.response.status));
  const rejected=await waitFor(async()=>{const status=await json(`/api/v1/uploads/${invalidUploadId}`,{headers:{Cookie:cookie}});return status.body.status==='failed'?status.body:null;},'Broken audio was not rejected');
  assert.equal(rejected.error,'Файл не распознан как аудио');
  assert.equal(await db.prepare("SELECT count(*) count FROM tracks WHERE filename='broken.mp3'").get().then(row=>Number(row.count)),0);
  assert.equal(fs.existsSync(path.join(storageDir,'uploads',`${invalidUploadId}.part`)),false);

  let stream = await fetch(`${origin}/api/v1/tracks/${ready.track_id}/stream`, { headers: { Cookie: cookie, Range: 'bytes=0-15' } });
  assert.equal(stream.status, 206);
  assert.match(stream.headers.get('content-range'), /^bytes 0-15\/\d+$/);
  assert.equal((await stream.arrayBuffer()).byteLength, 16);

  stream = await fetch(`${origin}/api/v1/tracks/${ready.track_id}/stream`, { headers: { Cookie: cookie, Range: 'bytes=999999-' } });
  assert.equal(stream.status, 416);
  assert.match(stream.headers.get('content-range'), /^bytes \*\/\d+$/);

  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'family',password:accountSecret})});
  assert.equal(result.response.status,200);const familyCookie=result.response.headers.get('set-cookie').split(';',1)[0];
  result=await json(`/api/v1/users/${familyId}/password`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify({new_password:familyCredential})});
  assert.equal(result.response.status,200);
  result=await json('/api/v1/me',{headers:{Cookie:familyCookie}});assert.equal(result.response.status,401);
  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'family',password:accountSecret})});assert.equal(result.response.status,401);
  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'family',password:familyCredential})});assert.equal(result.response.status,200);

  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'integration',password:accountSecret,device_name:'Password change victim'})});
  assert.equal(result.response.status,200);const passwordVictimCookie=result.response.headers.get('set-cookie').split(';',1)[0];
  result=await json('/api/v1/me/password',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify({current_password:'wrong-password',new_password:changedCredential})});assert.equal(result.response.status,400);
  result=await json('/api/v1/me/password',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify({current_password:accountSecret,new_password:changedCredential})});assert.equal(result.response.status,200);
  result=await json('/api/v1/me',{headers:{Cookie:passwordVictimCookie}});assert.equal(result.response.status,401);
  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'integration',password:accountSecret})});assert.equal(result.response.status,401);
  result=await json('/api/v1/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'integration',password:changedCredential})});assert.equal(result.response.status,200);

  result = await json('/api/v1/logout', { method:'POST', headers:{ Cookie:cookie } });
  assert.equal(result.response.status,403);
  result = await json('/api/v1/logout', { method:'POST', headers:{ Cookie:cookie, Origin:origin } });
  assert.equal(result.response.status,200);
  result = await json('/api/v1/me', { headers:{ Cookie:cookie } });
  assert.equal(result.response.status,401);
  console.log('Media integration test passed');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await db?.close().catch(() => {});
  fs.rmSync(storageDir, { recursive: true, force: true });
}
