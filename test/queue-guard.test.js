import test from 'node:test';
import assert from 'node:assert/strict';
import { guardQueue } from '../src/queue-guard.js';
import { createUploadWorker } from '../src/upload-worker.js';
import { createUploadJobService } from '../src/upload-jobs.js';

test('upload processing and recovery use the same shared/exclusive queue guard',async()=>{
  const calls=[];
  const db={async withQueueLock(queue,exclusive){calls.push({queue,exclusive});return false;},prepare(){throw new Error('Must not query without guard');},transaction(){throw new Error('Must not recover without guard');}};
  const jobs=createUploadJobService({db});
  const worker=createUploadWorker({db,uploadJobs:jobs});
  assert.equal(await worker.processNext(),false);
  assert.equal(await jobs.recover(),false);
  assert.deepEqual(calls,[{queue:'uploads',exclusive:false},{queue:'uploads',exclusive:true}]);
});

test('queue guard propagates errors and preserves unit-test adapters',async()=>{
  assert.equal(guardQueue({},'uploads',false,()=>7),7);
  await assert.rejects(guardQueue({withQueueLock:async(_q,_x,fn)=>fn()},'uploads',true,()=>{throw new Error('fixture');}),/fixture/);
});
