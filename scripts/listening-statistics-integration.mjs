import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createListeningEvents} from '../src/listening-events.js';
import {ListeningTracker} from '../public/listening-tracker.js';
import {ListeningJournal} from '../public/listening-journal.js';

const databaseUrl=process.env.STATISTICS_TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('STATISTICS_TEST_DATABASE_URL must name a separate empty test database');
const pool=new pg.Pool({connectionString:databaseUrl});
const origin=`http://127.0.0.1:${Number(process.env.STATISTICS_TEST_PORT||18105)}`;
const password=crypto.randomBytes(24).toString('base64url');
let server,storage;
async function request(route,cookie,method='GET',body){
  const response=await fetch(origin+'/api/v1'+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';',1)[0]};
}
try{
  const exists=(await pool.query("SELECT to_regclass('public.users') AS users")).rows[0].users;
  assert.equal(exists,null,'Refusing a database with an existing application schema');
  storage=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-statistics-test-'));
  server=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,DATABASE_URL:databaseUrl,MUSIC_HOST:'127.0.0.1',MUSIC_PORT:new URL(origin).port,MUSIC_STORAGE_DIR:storage,MUSIC_CONNECT_ENABLED:'true'},stdio:['ignore','ignore','pipe']});
  let errors='';server.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
  let ready=false;
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw new Error('Test API exited: '+errors);
    try{ready=(await fetch(origin+'/api/v1/health')).ok;}catch{}
    if(ready)break;await delay(100);
  }
  assert.ok(ready,'Statistics API did not start');
  assert.equal((await request('/setup',null,'POST',{username:'statistics-admin',display_name:'Statistics admin',password,library_name:'Statistics test',recognition_enabled:false})).status,201);
  const admin=await request('/login',null,'POST',{username:'statistics-admin',password});assert.equal(admin.status,200);
  assert.equal((await request('/users',admin.cookie,'POST',{username:'statistics-other',display_name:'Statistics other',password})).status,201);
  const other=await request('/login',null,'POST',{username:'statistics-other',password});assert.equal(other.status,200);
  assert.equal((await request('/setup/status')).data.features.android_settings_portal,1);
  for(const endpoint of ['/admin/stats','/admin/metrics','/admin/registration-settings','/admin/recognition-settings','/admin/openvk-settings','/users']){
    assert.equal((await request(endpoint,admin.cookie)).status,200,endpoint);
    assert.equal((await request(endpoint,other.cookie)).status,403,endpoint);
  }
  assert.equal((await request('/connect/settings',other.cookie)).status,200);
  const users=(await pool.query('SELECT id,username FROM users ORDER BY id')).rows;
  const owner=users.find(user=>user.username==='statistics-admin').id,second=users.find(user=>user.username==='statistics-other').id;
  const ids=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
  for(let i=0;i<ids.length;i++)await pool.query(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,storage_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'audio/mpeg',1024,$7,CURRENT_TIMESTAMP-($8::int*INTERVAL '1 day'))`,
    [ids[i],owner,'Statistics track '+i,i===0?'Statistics Lead feat. Statistics Guest':'Statistics Lead','Statistics Album','test.mp3','originals/'+ids[i]+'.mp3',i===1?40:0]);
  await pool.query(`INSERT INTO play_history(user_id,track_id,play_count,last_played_at) VALUES
    ($1,$3,7,CURRENT_TIMESTAMP),($1,$4,2,CURRENT_TIMESTAMP-INTERVAL '40 days'),($2,$5,99,CURRENT_TIMESTAMP)`,[owner,second,...ids]);
  await pool.query('INSERT INTO track_likes(user_id,track_id) VALUES($1,$2),($3,$4)',[owner,ids[0],second,ids[2]]);
  await pool.query('INSERT INTO playlists(id,owner_id,title) VALUES($1,$2,$3)',[crypto.randomUUID(),owner,'Statistics playlist']);
  for(const endpoint of ['/statistics/me','/admin/usage'])assert.equal((await request(endpoint)).status,401);
  assert.equal((await request('/admin/usage',other.cookie)).status,403);
  const personal=await request('/statistics/me?user_id='+second,admin.cookie);
  assert.equal(personal.status,200);assert.equal(personal.data.summary.recorded_plays,9);
  assert.equal(personal.data.summary.unique_tracks,2);assert.equal(personal.data.summary.likes,1);assert.equal(personal.data.summary.playlists,1);
  assert.equal(personal.data.summary.recent_tracks_7d,1);assert.equal(personal.data.summary.recent_tracks_30d,1);
  assert.equal(personal.data.listening_seconds,null);assert.equal(personal.data.period_plays_available,false);
  assert.equal(personal.data.top_tracks.length,2);assert.ok(!personal.data.top_tracks.some(item=>item.id===ids[2]));
  assert.equal(personal.data.top_artists.find(item=>item.name==='Statistics Lead').recorded_plays,9);
  assert.equal(personal.data.top_artists.find(item=>item.name==='Statistics Guest').recorded_plays,7);
  assert.equal(personal.data.top_albums.length,1);assert.equal(personal.data.top_albums[0].recorded_plays,9);
  const isolated=(await request('/statistics/me',other.cookie)).data;
  assert.equal(isolated.summary.recorded_plays,99);assert.equal(isolated.summary.playlists,0);
  const usage=(await request('/admin/usage',admin.cookie)).data;
  assert.equal(usage.activity.recorded_plays,108);assert.equal(usage.activity.listeners_7d,2);
  assert.equal(usage.collections.accounts,2);assert.equal(usage.library.tracks,3);assert.equal(usage.library.added_tracks_7d,2);
  assert.equal(usage.sessions.active_sessions,2);assert.equal(usage.sessions.accounts_with_sessions,2);
  assert.equal(usage.top_tracks,undefined);assert.equal(usage.listening_seconds,null);
  assert.doesNotMatch(JSON.stringify(usage),/Statistics Lead|statistics-other|token_hash|ip_address/);
  assert.equal(Number((await pool.query('SELECT sum(play_count) AS count FROM play_history')).rows[0].count),108);
  // Measured counters are separate from legacy launch history, opt-in and cumulative.
  assert.equal((await request('/statistics/settings',admin.cookie)).data.enabled,false);
  const nonce=crypto.randomUUID();
  const counter={playback_id:nonce,track_id:ids[0],client_type:'web',generation:0,elapsed_ms:0};
  const send=(body=counter,cookie=admin.cookie)=>request('/statistics/events',cookie,'POST',body);
  assert.equal((await send()).data.status,'disabled');
  assert.equal(Number((await pool.query('SELECT count(*) FROM listening_sessions')).rows[0].count),0);
  const enabled=await request('/statistics/settings',admin.cookie,'PUT',{enabled:true});
  assert.equal(enabled.status,200);counter.generation=enabled.data.generation;assert.equal(counter.generation,1);
  assert.equal((await request('/statistics/settings',admin.cookie,'PUT',{enabled:true})).data.generation,1);
  assert.equal((await send()).status,200);assert.equal((await send()).data.elapsed_ms,0);
  assert.equal((await send({...counter,elapsed_ms:10000})).data.error_code,'statistics_invalid_time');
  await pool.query("UPDATE listening_sessions SET started_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE user_id=$1",[owner]);
  await send({...counter,elapsed_ms:10000});await send({...counter,elapsed_ms:10000});
  const concurrent=await Promise.all([20000,30000,25000].map(elapsed_ms=>send({...counter,elapsed_ms})));
  assert.ok(concurrent.every(response=>response.status===200));
  let measured=(await request('/statistics/listening?period=7',admin.cookie)).data;
  assert.equal(measured.listening_seconds,30);assert.equal(measured.qualified_plays,1);
  assert.equal(measured.top_tracks[0].id,ids[0]);assert.equal(measured.top_artists.length,2);
  assert.equal(measured.daily.at(-1).day,new Date().toISOString().slice(0,10));
  assert.equal((await request('/admin/listening',other.cookie)).status,403);
  assert.equal((await request('/statistics/listening?period=bad',admin.cookie)).status,400);
  assert.equal((await send({...counter,track_id:ids[1],elapsed_ms:40000})).data.error_code,'statistics_conflict');
  const anotherLogin=await request('/login',null,'POST',{username:'statistics-admin',password});
  assert.equal((await send({...counter,elapsed_ms:40000},anotherLogin.cookie)).data.error_code,'statistics_conflict');
  const receiver='statistics_executor_device',controller='statistics_controller_device';
  for(const id of [receiver,controller])assert.equal((await request('/connect/devices',admin.cookie,'POST',{id,name:'Statistics test',client_type:'web',capabilities:{playback:true}})).status,200);
  assert.equal((await request('/connect/state',admin.cookie,'PUT',{device_id:receiver,track_id:ids[0],queue:[ids[0]],playing:true})).status,200);
  assert.equal((await send({...counter,elapsed_ms:40000,device_id:controller})).data.error_code,'statistics_not_executor');
  assert.equal((await send({...counter,elapsed_ms:40000,device_id:receiver})).status,200);
  await request('/connect/settings',admin.cookie,'PUT',{enabled:false});
  assert.equal((await send({...counter,elapsed_ms:50000,device_id:controller})).status,200);
  const otherSettings=(await request('/statistics/settings',other.cookie,'PUT',{enabled:true})).data;
  const otherCounter={...counter,generation:otherSettings.generation};
  assert.equal((await send(otherCounter,other.cookie)).status,200);
  await pool.query("UPDATE listening_sessions SET started_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE user_id=$1",[second]);
  assert.equal((await send({...otherCounter,elapsed_ms:20000},other.cookie)).status,200);
  assert.equal((await request('/statistics/listening',other.cookie)).data.listening_seconds,20);
  let aggregate=(await request('/admin/listening',admin.cookie)).data;
  assert.equal(aggregate.listening_seconds,70);assert.equal(aggregate.listeners,2);assert.equal(aggregate.qualified_plays,1);
  assert.doesNotMatch(JSON.stringify(aggregate),/Statistics Lead|statistics-other|track_id|ip_address/);
  await pool.query(`INSERT INTO listening_daily(user_id,track_id,day,client_type,elapsed_ms,plays)
    VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-40,'web',5000,1)`,[owner,ids[1]]);
  assert.equal((await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds,55);
  assert.equal((await request('/statistics/listening?period=30',admin.cookie)).data.listening_seconds,50);
  await request('/statistics/settings',admin.cookie,'PUT',{enabled:false});
  assert.equal((await send({...counter,elapsed_ms:60000})).data.status,'disabled');
  const again=(await request('/statistics/settings',admin.cookie,'PUT',{enabled:true})).data;
  assert.equal(again.generation,3);assert.equal((await send(counter)).data.error_code,'statistics_generation_changed');
  const fresh={...counter,playback_id:crypto.randomUUID(),generation:again.generation};
  assert.equal((await send(fresh)).status,200);
  const cleared=(await request('/statistics/listening?user_id='+second,admin.cookie,'DELETE')).data;
  assert.equal(cleared.generation,4);assert.equal(cleared.enabled,true);
  assert.equal((await send(fresh)).data.error_code,'statistics_generation_changed');
  assert.equal((await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds,0);
  assert.equal((await request('/statistics/listening?period=all',other.cookie)).data.listening_seconds,20);
  assert.equal((await request('/statistics/me',admin.cookie)).data.summary.recorded_plays,9);
  await pool.query(`INSERT INTO listening_sessions(user_id,playback_id,auth_session_id,generation,track_id,client_type,threshold_ms,started_at,updated_at)
    VALUES($1,$2,1,4,$3,'web',30000,CURRENT_TIMESTAMP-INTERVAL '31 days',CURRENT_TIMESTAMP-INTERVAL '31 days')`,[owner,crypto.randomUUID(),ids[0]]);
  await createListeningEvents({db:{prepare:sql=>({run:()=>pool.query(sql)})}}).cleanup();
  assert.equal(Number((await pool.query('SELECT count(*) FROM listening_sessions WHERE user_id=$1',[owner])).rows[0].count),0);
  assert.equal((await request('/statistics/listening',other.cookie)).data.listening_seconds,20);
  assert.equal(Number((await pool.query('SELECT sum(play_count) AS count FROM play_history')).rows[0].count),108);
  console.log('Measured PostgreSQL/HTTP: opt-in, replay/concurrency, clock bounds, qualified threshold, Connect executor, session binding, UTC periods, generation-safe clear, isolation and retention OK');
  // Actual WEB transport class against the HTTP API with a synthetic advancing
  // media clock. This is deliberately not a claim to browser/audio testing.
  const base=performance.now();
  const tracker=new ListeningTracker({
    api:async(url,options={})=>{
      const response=await request(url.replace('/api/v1',''),admin.cookie,options.method||'GET',options.body?JSON.parse(options.body):undefined);
      if(response.status!==200)throw Object.assign(new Error('Synthetic collector request failed'),{status:response.status,code:response.data.error_code});
      return response.data;
    },
    sample:()=>({trackId:ids[0],positionSeconds:(performance.now()-base)/1000,rate:1,playing:true,executing:true}),
    schedule:()=>0,cancel:()=>{},uuid:()=>crypto.randomUUID(),
  });
  async function wait(check){const until=Date.now()+10000;while(Date.now()<until){if(await check())return;await delay(20);}throw new Error('Synthetic WEB collector timed out');}
  try{
    tracker.start();await wait(()=>tracker.enabled);tracker.tick();
    await wait(()=>tracker.current?.started);
    for(let i=0;i<5;i++){await delay(1000);tracker.tick();}
    const elapsed=tracker.current.elapsed_ms;assert.ok(elapsed>=4000);
    tracker.finish();await wait(async()=>{const result=await request('/statistics/listening?period=all',admin.cookie);return result.data.listening_seconds===elapsed/1000;});
    console.log('WEB collector + real HTTP: synthetic advancing media clock, initial zero handshake and final cumulative time OK');
  }finally{tracker.stop();}
  const {IDBFactory}=await import(process.env.STATISTICS_INDEXEDDB_MODULE||'fake-indexeddb');
  const indexedDB=new IDBFactory();
  const journalSettings=(await request('/statistics/settings',admin.cookie)).data;
  assert.match(journalSettings.journal_scope,/^[0-9a-f]{64}$/);
  assert.equal((await request('/statistics/settings',admin.cookie)).data.journal_scope,journalSettings.journal_scope);
  assert.notEqual((await request('/statistics/settings',anotherLogin.cookie)).data.journal_scope,journalSettings.journal_scope);
  let loseAck=false,sawLost=false;const journalBase=performance.now();
  const journalApi=async(url,options={})=>{
    const response=await request(url.replace('/api/v1',''),admin.cookie,options.method||'GET',options.body?JSON.parse(options.body):undefined);
    if(response.status!==200)throw Object.assign(new Error('Journal collector request failed'),{status:response.status,code:response.data.error_code});
    if(loseAck&&options.body&&JSON.parse(options.body).elapsed_ms>0){loseAck=false;sawLost=true;throw new Error('Simulated lost ACK');}
    return response.data;
  };
  const firstJournal=new ListeningJournal({indexedDB});
  const firstCollector=new ListeningTracker({api:journalApi,journal:firstJournal,sample:()=>({trackId:ids[0],
    positionSeconds:(performance.now()-journalBase)/1000,rate:1,playing:true,executing:true}),schedule:()=>0,cancel:()=>{}});
  let replayCollector;
  try{
    firstCollector.start();await wait(()=>firstCollector.enabled&&firstCollector.journalReady);firstCollector.tick();
    await wait(()=>firstCollector.current?.started);
    for(let i=0;i<3;i++){await delay(1000);firstCollector.tick();}
    const journalId=firstCollector.current.playback_id,elapsed=firstCollector.current.elapsed_ms;
    loseAck=true;firstCollector.finish();await wait(()=>sawLost);firstCollector.suspend();
    await firstJournal.transaction(journalSettings.journal_scope,()=>{}); // drain queued durable checkpoints
    const beforeReplay=(await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds;
    replayCollector=new ListeningTracker({api:journalApi,journal:new ListeningJournal({indexedDB}),
      sample:()=>({playing:false,executing:false}),schedule:()=>0,cancel:()=>{}});
    replayCollector.start();await wait(()=>replayCollector.enabled&&replayCollector.journalReady);
    assert.equal(replayCollector.entries.get(journalId)?.elapsed_ms,elapsed);
    replayCollector.tick();await wait(()=>!replayCollector.entries.has(journalId));
    assert.equal((await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds,beforeReplay);
    const foreignScope={playback_id:crypto.randomUUID(),track_id:ids[0],client_type:'web',generation:journalSettings.generation,
      elapsed_ms:0,journal_scope:journalSettings.journal_scope,started_at_ms:Date.now()};
    assert.equal((await send(foreignScope,anotherLogin.cookie)).data.error_code,'statistics_conflict');
    console.log('WEB IndexedDB + real HTTP: durable lost-ACK replay after document restart, no double credit, opaque login scope enforced OK');
  }finally{firstCollector.stop();replayCollector?.stop();}
  // Simulate cached listening started before reconnect, within the same consent
  // and login. Only synthetic test timestamps are moved, never production rows.
  const offlineStart=Date.now()-120000;
  await pool.query("UPDATE listening_preferences SET started_at=CURRENT_TIMESTAMP-INTERVAL '10 minutes' WHERE user_id=$1",[owner]);
  await pool.query("UPDATE sessions SET created_at=CURRENT_TIMESTAMP-INTERVAL '10 minutes' WHERE user_id=$1",[owner]);
  const offlineSettings=(await request('/statistics/settings',admin.cookie)).data;
  assert.equal(offlineSettings.offline_window_ms,86400000);
  const beforeOffline=(await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds;
  const offlineCounter={playback_id:crypto.randomUUID(),track_id:ids[0],client_type:'android',generation:offlineSettings.generation,elapsed_ms:0,started_at_ms:offlineStart};
  assert.equal((await send(offlineCounter)).status,200);
  assert.equal((await send({...offlineCounter,elapsed_ms:60000})).status,200);
  const replay=await Promise.all([120000,120000,60000].map(elapsed_ms=>send({...offlineCounter,elapsed_ms})));
  assert.ok(replay.every(response=>response.status===200));
  assert.equal((await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds,beforeOffline+120);
  const receipt=(await pool.query('SELECT started_at,received_at FROM listening_sessions WHERE user_id=$1 AND playback_id=$2',[owner,offlineCounter.playback_id])).rows[0];
  assert.ok(new Date(receipt.received_at)-new Date(receipt.started_at)>=119000);
  for(const started_at_ms of [Date.now()+10000,Date.now()-86400001,Date.now()-700000])
    assert.equal((await send({...offlineCounter,playback_id:crypto.randomUUID(),started_at_ms})).status,400);
  const newSession=await request('/login',null,'POST',{username:'statistics-admin',password});
  assert.equal((await send({...offlineCounter,playback_id:crypto.randomUUID()},newSession.cookie)).status,400);
  await request('/statistics/settings',admin.cookie,'PUT',{enabled:false});
  const renewed=(await request('/statistics/settings',admin.cookie,'PUT',{enabled:true})).data;
  assert.equal((await send({...offlineCounter,playback_id:crypto.randomUUID(),generation:renewed.generation})).status,400);
  await request('/statistics/listening',admin.cookie,'DELETE');
  assert.equal((await send(offlineCounter)).data.error_code,'statistics_generation_changed');
  assert.equal((await request('/statistics/listening?period=all',admin.cookie)).data.listening_seconds,0);
  // Backdating a start must not bypass the limit on newly received sessions.
  const afterClear=(await request('/statistics/settings',admin.cookie)).data;
  await pool.query(`INSERT INTO listening_sessions(user_id,playback_id,auth_session_id,generation,track_id,client_type,threshold_ms,started_at)
    SELECT $1,md5('offline-rate-test-'||n::text)::uuid,1,$2,$3,'android',30000,CURRENT_TIMESTAMP-INTERVAL '2 hours'
    FROM generate_series(1,240) n`,[owner,afterClear.generation,ids[0]]);
  assert.equal((await send({...offlineCounter,playback_id:crypto.randomUUID(),generation:afterClear.generation,started_at_ms:Date.now()})).status,429);
  console.log('Offline Android protocol: delayed start, bounded time, original login/consent, receipt-based rate accounting, replay and clear OK');
  const adminConnectBefore=(await request('/connect/settings',admin.cookie)).data.user_enabled;
  assert.equal((await request('/connect/settings',other.cookie,'PUT',{enabled:false})).status,200);
  assert.equal((await request('/connect/settings',other.cookie)).data.user_enabled,false);
  assert.equal((await request('/connect/settings',admin.cookie)).data.user_enabled,adminConnectBefore);
  assert.equal((await request('/admin/registration-settings',other.cookie,'PUT',{enabled:true})).status,403);
  assert.equal((await request('/admin/registration-settings',admin.cookie,'PUT',{enabled:true})).status,200);
  assert.equal((await request('/setup/status')).data.registration_enabled,true);
  await request('/admin/registration-settings',admin.cookie,'PUT',{enabled:false});
  const changedPassword=crypto.randomBytes(24).toString('base64url');
  assert.equal((await request('/me/password',other.cookie,'PUT',{current_password:password,new_password:changedPassword})).status,200);
  assert.equal((await request('/me',other.cookie)).status,200);
  assert.equal((await request('/login',null,'POST',{username:'statistics-other',password})).status,401);
  assert.equal((await request('/login',null,'POST',{username:'statistics-other',password:changedPassword})).status,200);
  console.log('Android settings API: fresh role permissions, account-scoped Connect, admin-only registration and own-password flow OK');
  const module=await fetch(origin+'/listening-statistics.js');assert.equal(module.status,200);
  console.log('Statistics PostgreSQL/HTTP: account isolation, admin access, real aggregates, feat/album grouping, historical limits and WEB module OK');
}finally{
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
  await pool.end();
  if(storage)fs.rmSync(storage,{recursive:true,force:true});
}
