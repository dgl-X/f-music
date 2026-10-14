import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStatusLabel } from '../public/connect-status.js';

test('Connect status prioritizes lost connectivity over playback',()=>{
  assert.equal(connectStatusLabel({enabled:true,connection:'reconnecting',remote:true,state:{playing:true}}),'Connect · восстанавливаем связь');
  assert.equal(connectStatusLabel({enabled:false,connection:'error'}),'');
});
test('Connect distinguishes command submission, preparation and remote buffering',()=>{
  assert.equal(connectStatusLabel({enabled:true,pending:1}),'Connect · отправляем команду');
  assert.equal(connectStatusLabel({enabled:true,preparing:true}),'Connect · готовим передачу');
  assert.equal(connectStatusLabel({enabled:true,remote:true,state:{playing:true,playback_status:'buffering'}}),'Другое устройство · буферизация');
  assert.equal(connectStatusLabel({enabled:true,remote:true,state:{playing:false}}),'Другое устройство · пауза');
});
