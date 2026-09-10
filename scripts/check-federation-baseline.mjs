#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FEDERATION_CAPABILITIES, FEDERATION_PROTOCOL_MAJOR, FEDERATION_PROTOCOL_MINOR, negotiateFederation, validateDeltaCompatibility } from '../src/federation-protocol.js';

const manifest=JSON.parse(fs.readFileSync(new URL('../federation/compat/baseline-v0.1.1.json',import.meta.url),'utf8'));
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const snapshot=file=>fs.readFileSync(new URL(`../federation/compat/${manifest.release}/${file.split('/').pop()}`,import.meta.url),'utf8');
const fromTag=file=>{
  try{return execFileSync('git',['show',`${manifest.release}:${file}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}
  catch{return null;}
};

const baselineSource=snapshot('src/federation-protocol.js');
if(sha256(baselineSource)!==manifest.protocol_sha256)throw new Error(`${manifest.release}: изменился закреплённый federation protocol`);
const taggedProtocol=fromTag('src/federation-protocol.js');
if(taggedProtocol!==null&&taggedProtocol!==baselineSource)throw new Error(`${manifest.release}: snapshot протокола не совпадает с release-тегом`);
const baseline=await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`);
if(baseline.FEDERATION_PROTOCOL_MAJOR!==manifest.protocol_major||baseline.FEDERATION_PROTOCOL_MINOR!==manifest.protocol_minor)throw new Error('Версия baseline не соответствует manifest');

for(const [file,expectedHash] of Object.entries(manifest.schemas)){
  const oldText=snapshot(file),oldSchema=JSON.parse(oldText),currentSchema=JSON.parse(fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
  if(sha256(oldText)!==expectedHash)throw new Error(`${manifest.release}: изменилась закреплённая schema ${file}`);
  const taggedSchema=fromTag(file);
  if(taggedSchema!==null&&taggedSchema!==oldText)throw new Error(`${manifest.release}: snapshot ${file} не совпадает с release-тегом`);
  if(oldSchema.additionalProperties!==true||currentSchema.additionalProperties!==true)throw new Error(`${file}: v1 обязан допускать неизвестные поля`);
  const oldRequired=new Set(oldSchema.required||[]),addedRequired=(currentSchema.required||[]).filter(field=>!oldRequired.has(field));
  if(addedRequired.length)throw new Error(`${file}: новая версия требует отсутствующие в ${manifest.release} поля: ${addedRequired.join(', ')}`);
}

const baselineDescriptor={protocols:{[manifest.protocol_major]:{minor:manifest.protocol_minor}},capabilities:baseline.FEDERATION_CAPABILITIES};
const currentDescriptor={protocols:{[FEDERATION_PROTOCOL_MAJOR]:{minor:FEDERATION_PROTOCOL_MINOR}},capabilities:FEDERATION_CAPABILITIES,future_optional_field:true};
const required=['pairing.v1','catalog.delta.v1'];
for(const [name,result] of [['current-reader/baseline-producer',negotiateFederation(baselineDescriptor,required)],['baseline-reader/current-producer',baseline.negotiateFederation(currentDescriptor,required)]])if(result.status==='upgrade_required')throw new Error(`${name}: нет совместимого federation v1`);

const event={revision:1,type:'track.upsert.v1',event_version:1,critical:true,origin_id:'fm:compatibility-baseline',object_id:'track-1',occurred_at:'2026-09-10T00:00:00.000Z',payload:{title:'Compatibility'}};
const baselinePage={protocol_version:1,producer_minor:manifest.protocol_minor,min_reader_minor:0,items:[event],next_cursor:'fm-cursor-v1:MA',has_more:false};
const currentPage={...baselinePage,producer_minor:FEDERATION_PROTOCOL_MINOR,future_optional_field:{ignored:true}};
validateDeltaCompatibility(baselinePage);
baseline.validateDeltaCompatibility(currentPage);

console.log(JSON.stringify({ok:true,baseline:manifest.release,matrix:['current-reader/baseline-producer','baseline-reader/current-producer'],schemas:Object.keys(manifest.schemas).length}));
