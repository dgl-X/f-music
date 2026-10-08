import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenVkProvider, normalizeOpenVkRange, normalizeOpenVkSourceId, sanitizeOpenVkTrack, validateOpenVkMediaUrl } from '../src/openvk-provider.js';

test('OpenVK settings are stored transactionally and normalize copied tokens', async () => {
  const values=new Map([['openvk_enabled','false'],['openvk_access_token','old-token']]);
  const connection={
    prepare(sql){
      if(sql.startsWith('SELECT key,value'))return{async all(){return [...values].map(([key,value])=>({key,value}));}};
      return{async run(value){values.set(sql.includes("'openvk_enabled'")?'openvk_enabled':'openvk_access_token',value);}};
    },
  };
  const db={...connection,async transaction(callback){await callback(connection);}};
  const provider=createOpenVkProvider({db,uploadDir:'/tmp',maxUploadBytes:1024,fetchImpl:async()=>{throw new Error('unexpected fetch');}});
  const state=await provider.updateSettings({enabled:true,accessToken:'  access_token=new-token  '});
  assert.deepEqual(state,{enabled:true,token:'new-token'});
  assert.equal(values.get('openvk_enabled'),'true');
  assert.equal(values.get('openvk_access_token'),'new-token');
});

test('OpenVK source IDs are strict owner and audio pairs', () => {
  assert.equal(normalizeOpenVkSourceId('27717_5'),'27717_5');
  assert.equal(normalizeOpenVkSourceId('-7_12'),'-7_12');
  assert.equal(normalizeOpenVkSourceId('1_2_extra'),null);
});

test('OpenVK results expose metadata without source URLs', () => {
  const track=sanitizeOpenVkTrack({owner_id:27717,id:5,artist:'Баста',title:'ЧП',duration:315,url:'https://cdn.openvk.org/private.mp3'});
  assert.deepEqual(track,{source_id:'27717_5',title:'ЧП',artist:'Баста',album:'',genre:'',duration_seconds:315,explicit:false});
  assert.equal('url' in track,false);
});

test('OpenVK media import only accepts the fixed HTTPS CDN', () => {
  assert.equal(validateOpenVkMediaUrl('https://cdn.openvk.org/audio/file.mp3')?.hostname,'cdn.openvk.org');
  assert.equal(validateOpenVkMediaUrl('http://cdn.openvk.org/audio/file.mp3'),null);
  assert.equal(validateOpenVkMediaUrl('https://cdn.openvk.org.evil.test/file.mp3'),null);
  assert.equal(validateOpenVkMediaUrl('https://127.0.0.1/file.mp3'),null);
});

test('OpenVK preview forwards only a single valid byte range', () => {
  assert.equal(normalizeOpenVkRange('bytes=0-65535'),'bytes=0-65535');
  assert.equal(normalizeOpenVkRange('bytes=1024-'),'bytes=1024-');
  assert.equal(normalizeOpenVkRange('bytes=-4096'),'bytes=-4096');
  assert.equal(normalizeOpenVkRange(undefined),null);
  assert.equal(normalizeOpenVkRange('bytes=0-1,4-8'),undefined);
  assert.equal(normalizeOpenVkRange('items=0-10'),undefined);
});
