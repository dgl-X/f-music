import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const databaseUrl=process.env.CONNECT_TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('CONNECT_TEST_DATABASE_URL is required');

const port=Number(process.env.CONNECT_TEST_PORT||18097),origin=`http://127.0.0.1:${port}`;
const storageDir=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-connect-test-'));
const username='connect-integration',password=['connect','integration',String(process.pid)].join('-');
let server;

async function waitFor(check,message,timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){try{if(await check())return;}catch{}await delay(100);}
  throw new Error(message);
}

async function run(command,args,env={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,...env},stdio:'inherit'});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited with ${code??signal}`)));
  });
}

try{
  server=spawn(process.execPath,['src/server.js'],{
    cwd:path.resolve(import.meta.dirname,'..'),
    env:{...process.env,DATABASE_URL:databaseUrl,MUSIC_HOST:'127.0.0.1',MUSIC_PORT:String(port),MUSIC_STORAGE_DIR:storageDir,MUSIC_CONNECT_ENABLED:'true'},
    stdio:['ignore','pipe','pipe'],
  });
  server.stdout.pipe(process.stdout);server.stderr.pipe(process.stderr);
  await waitFor(async()=>{const response=await fetch(`${origin}/api/v1/health`);return response.ok;},'Connect test API did not start');
  const setup=await fetch(`${origin}/api/v1/setup`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username,display_name:'Connect Integration',password,library_name:'Connect Integration',recognition_enabled:false})});
  assert.equal(setup.status,201,await setup.text());
  await run(process.execPath,['scripts/connect-smoke.mjs'],{CONNECT_TEST_ORIGIN:origin,CONNECT_TEST_USERNAME:username,CONNECT_TEST_PASSWORD:password});
}finally{
  if(server&&!server.killed){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);}
  fs.rmSync(storageDir,{recursive:true,force:true});
}
