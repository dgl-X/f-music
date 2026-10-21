import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/db.js';
import { createUploadJobService } from '../src/upload-jobs.js';
import { createUploadWorker } from '../src/upload-worker.js';

const uri=process.env.WORKER_TEST_DATABASE_URL;
if(!uri||!/^fm_worker_test_[a-z0-9_]+$/.test(new URL(uri).pathname.slice(1)))throw new Error('Dedicated fm_worker_test_* database required');
const db=await openDatabase(uri);
const jobs=createUploadJobService({db});
if(process.argv.includes('--owner')){
  let finish;
  const worker=createUploadWorker({db,uploadJobs:jobs,startOperation:()=>async()=>{},uploadProcessor:{async process(){process.send({event:'running'});await new Promise(resolve=>{finish=resolve;});return{status:'ready'};}}});
  process.on('message',message=>{if(message==='finish')finish?.();});
  await worker.processNext();
  process.send({event:'done'});
  await db.close();
  process.disconnect();
}else{
  const children=[];
  try{
    assert.equal(Number((await db.prepare('SELECT count(*) count FROM users').get()).count),0,'Database must contain no accounts');
    const inserted=await db.prepare("INSERT INTO users(username,display_name,password_hash) VALUES('fixture','Fixture','not-a-login') RETURNING id").run();
    const userId=inserted.rows[0].id;
    const fixture=async id=>{
      await db.prepare("INSERT INTO uploads(id,user_id,filename,mime_type,total_bytes) VALUES(?,?,'fixture.flac','audio/flac',1)").run(id,userId);
      await jobs.enqueue({uploadId:id,candidateTrackId:'fixture-track'});
    };
    const startOwner=async()=>{
      const child=fork(import.meta.filename,['--owner'],{stdio:['ignore','inherit','inherit','ipc']});
      children.push(child);
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Owner startup timeout')),15000);
        child.on('message',message=>{if(message.event==='running'){clearTimeout(timer);resolve();}});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owner exited before claim'));});
      });
      return child;
    };
    await fixture('live-owner');
    const live=await startOwner();
    let recovered=false;
    const recovering=jobs.recover().then(()=>{recovered=true;});
    await delay(200);
    assert.equal(recovered,false,'Recovery must wait for the live job');
    assert.equal((await db.prepare('SELECT attempts FROM processing_jobs WHERE upload_id=?').get('live-owner')).attempts,1);
    const liveClosed=once(live,'exit');
    live.send('finish');
    await liveClosed;
    await recovering;
    assert.equal((await db.prepare('SELECT status FROM processing_jobs WHERE upload_id=?').get('live-owner')).status,'complete');
    await fixture('dead-owner');
    const dead=await startOwner();
    const afterDeath=jobs.recover();
    await delay(100);
    const deadClosed=once(dead,'exit');dead.kill('SIGKILL');await deadClosed;
    await afterDeath;
    const job=await jobs.claim();
    assert.equal(job.upload_id,'dead-owner');assert.equal(job.attempts,2);
    await jobs.complete(job.id);
    await fixture('lost-lock-owner');
    const lost=await startOwner();
    const holder=await db.prepare(`SELECT pid FROM pg_locks WHERE locktype='advisory'
      AND classid=1179471694 AND objid=1 AND mode='ShareLock' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`).get();
    assert.ok(holder);
    const lostClosed=once(lost,'exit');
    await db.prepare('SELECT pg_terminate_backend(?)').run(holder.pid);
    const [exitCode]=await lostClosed;
    assert.equal(exitCode,1,'Coordination loss must stop the owner, not continue side effects');
    await jobs.recover();
    const afterLockLoss=await jobs.claim();
    assert.equal(afterLockLoss.upload_id,'lost-lock-owner');
    await jobs.complete(afterLockLoss.id);
    for(const queue of ['uploads','transcode','loudness','recognition','replicas']){
      let release,entered;
      const started=new Promise(resolve=>{entered=resolve;});
      const active=db.withQueueLock(queue,false,async()=>{entered();await new Promise(resolve=>{release=resolve;});});
      await started;
      // Shared guards really permit concurrent processing, not global serialization.
      assert.equal(await db.withQueueLock(queue,false,()=>true),true);
      let reset=false;
      const recovery=db.withQueueLock(queue,true,()=>{reset=true;});
      await delay(100);assert.equal(reset,false);
      assert.equal(await db.withQueueLock(queue,false,()=>{throw new Error('New work passed waiting recovery');}),false);
      release();await active;await recovery;assert.equal(reset,true);
    }
    await assert.rejects(db.withQueueLock('uploads',false,()=>{throw new Error('fixture failure');}),/fixture failure/);
    assert.equal(await db.withQueueLock('uploads',true,()=>true),true,'Exception must release guard');
    console.log('PASS: live owner, SIGKILL orphan recovery, coordination loss fail-stop, all five queues, parallel jobs, recovery fairness and exception cleanup');
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill('SIGKILL');await closed;}
    await db.close();
  }
}
