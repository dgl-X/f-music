import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { captureMediaOutput, localMediaArgs, runMediaProcess } from '../src/media-process.js';
import { inspectAudio, runProcess } from '../src/media-tools.js';
import { validateAudioDecode } from '../src/audio-validation.js';

test('media process kills and reaps timed-out children', async () => {
  const result=await runMediaProcess(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{timeoutMs:300});
  assert.equal(result.error,'timeout');
  assert.equal(result.code,null);
  const pid=Number(result.stdout.trim());
  if(pid)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});

test('media process bounds combined stdout and stderr', async () => {
  const result=await runMediaProcess(process.execPath,['-e',"process.stderr.write('x'.repeat(100000));setInterval(()=>{},1000)"],{maxOutputBytes:1000,timeoutMs:3000});
  assert.equal(result.error,'output_limit');
  assert.ok(Buffer.byteLength(result.stdout+result.stderr)<=1000);
});

test('spawn failures and command failures settle without exposing stderr', async () => {
  assert.equal((await runMediaProcess('/nonexistent/family-music-tool',[])).error,'spawn_failed');
  await assert.rejects(captureMediaOutput(process.execPath,['-e',"console.error('private-value');process.exit(1)"]),error=>!error.message.includes('private-value'));
});

test('local media policy applies before every ffmpeg input and to ffprobe', () => {
  const args=localMediaArgs('ffmpeg',['-i','one','-i','two','out']);
  assert.equal(args.filter(arg=>arg==='-protocol_whitelist').length,2);
  assert.ok(localMediaArgs('/usr/bin/ffprobe',['in']).includes('file,pipe'));
  assert.deepEqual(localMediaArgs('fpcalc',['in']),['in']);
});

test('MP3 and FLAC still probe, decode and preserve original bytes', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-security-media-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const extension of ['mp3','flac']){
    const file=path.join(dir,`sample.${extension}`);
    // Fixture generation is trusted; lavfi is intentionally not an upload protocol.
    const generated=await runMediaProcess('ffmpeg',['-f','lavfi','-i','sine=frequency=440:duration=0.3','-threads','1',file]);
    assert.equal(generated.code,0,generated.stderr);
    const before=fs.readFileSync(file);
    assert.ok(Number((await inspectAudio(file)).duration)>0);
    assert.equal((await validateAudioDecode(file,0.3)).valid,true);
    await assert.rejects(inspectAudio(file,{maxOutputBytes:1}),error=>error.code==='media_output_limit');
    await assert.rejects(validateAudioDecode(file,0.3,{maxOutputBytes:1}),error=>error.code==='media_output_limit');
    assert.deepEqual(fs.readFileSync(file),before);
  }
});

test('ffprobe refuses remote media without making an HTTP request', async t => {
  let requests=0;
  const server=createServer((_req,res)=>{requests++;res.end('not audio');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/audio`;
  assert.equal(await inspectAudio(url),null);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-security-playlist-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const playlist=path.join(dir,'playlist.m3u8');
  fs.writeFileSync(playlist,`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}.ts\n#EXT-X-ENDLIST\n`);
  assert.equal(await inspectAudio(playlist),null);
  assert.equal(await runProcess('ffmpeg',['-v','error','-i',playlist,'-f','null','-']),false);
  assert.equal(requests,0);
});
