#!/usr/bin/env node
import crypto from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { applyFederationDeltaPage, catalogEvent, encodeCatalogCursor } from '../src/federation-catalog.js';

const sourceUrl = process.env.FEDERATION_SOURCE_DATABASE_URL;
const targetUrl = process.env.FEDERATION_TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) throw new Error('Нужны две разные тестовые PostgreSQL-базы');

const source = await openDatabase(sourceUrl);
const target = await openDatabase(targetUrl);
const sourceNode = `fm:${crypto.randomBytes(24).toString('base64url')}`;
const targetNode = `fm:${crypto.randomBytes(24).toString('base64url')}`;
const sourceTrack = crypto.randomUUID();
const targetTrack = crypto.randomUUID();

async function createOwner(db, name) {
  return (await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,1) RETURNING id')
    .run(name,name,'ci-only')).rows[0].id;
}

try {
  const sourceOwner = await createOwner(source,'source-admin');
  const targetOwner = await createOwner(target,'target-admin');
  await source.prepare(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sourceTrack,sourceOwner,'Песня с первой ноды','Исполнитель A','Альбом A','source.flac','audio/flac',4096,180,`tracks/${sourceTrack}.flac`);
  await target.prepare(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(targetTrack,targetOwner,'Локальная песня второй ноды','Исполнитель B','','target.mp3','audio/mpeg',2048,120,`tracks/${targetTrack}.mp3`);
  await target.prepare(`INSERT INTO federation_peers(node_id,label,public_key,endpoint,status,protocol_major,protocol_minor,capabilities_json)
    VALUES(?,?,?,?,?,1,0,'{}')`).run(sourceNode,'source','ci-public-key','https://source.invalid','compatible');

  const row = await source.prepare('SELECT revision,event_type,object_id,payload_json,occurred_at FROM federation_catalog_events WHERE object_id=? ORDER BY revision DESC LIMIT 1').get(sourceTrack);
  const upsert = catalogEvent(row,sourceNode);
  const firstCursor = encodeCatalogCursor(upsert.revision + 1);
  await applyFederationDeltaPage(target,sourceNode,{
    protocol_version:1,
    producer_minor:1,
    min_reader_minor:0,
    items:[upsert,{revision:upsert.revision+1,type:'artist.image.v1',event_version:1,critical:false,origin_id:sourceNode,object_id:'future-field',payload:{ignored_by_v1:true}}],
    next_cursor:firstCursor,
    has_more:false,
    future_field:{ignored_by_previous_reader:true},
  });
  const remote = await target.prepare('SELECT title,artist,revision FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(sourceNode,sourceTrack);
  if (remote?.title !== 'Песня с первой ноды' || remote.artist !== 'Исполнитель A') throw new Error('Вторая нода не применила track.upsert.v1');
  const localStillExists = await target.prepare('SELECT title FROM tracks WHERE id=?').get(targetTrack);
  if (localStillExists?.title !== 'Локальная песня второй ноды') throw new Error('Синхронизация затронула локальную библиотеку');

  let rejected = false;
  try {
    await applyFederationDeltaPage(target,sourceNode,{protocol_version:1,producer_minor:1,min_reader_minor:0,items:[{
      revision:upsert.revision+2,type:'catalog.rewrite.v2',event_version:1,critical:true,origin_id:sourceNode,object_id:'future-critical',payload:{},
    }],next_cursor:encodeCatalogCursor(upsert.revision+2),has_more:false});
  } catch (error) { rejected = error.code === 'unsupported_event'; }
  if (!rejected) throw new Error('Обязательное неизвестное событие не остановило старую ноду');
  const peerAfterFailure = await target.prepare('SELECT catalog_cursor FROM federation_peers WHERE node_id=?').get(sourceNode);
  if (peerAfterFailure.catalog_cursor !== firstCursor) throw new Error('Cursor изменился после отклонённой транзакции');

  await applyFederationDeltaPage(target,sourceNode,{protocol_version:1,producer_minor:0,min_reader_minor:0,items:[{
    revision:upsert.revision+3,type:'track.delete.v1',event_version:1,critical:true,origin_id:sourceNode,object_id:sourceTrack,payload:{},
  }],next_cursor:encodeCatalogCursor(upsert.revision+3),has_more:false});
  if (await target.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(sourceNode,sourceTrack)) throw new Error('Вторая нода не применила track.delete.v1');
  if (!(await target.prepare('SELECT 1 FROM tracks WHERE id=?').get(targetTrack))) throw new Error('Удаление remote-трека затронуло локальный трек');

  console.log(JSON.stringify({ok:true,nodes:2,upsert:true,optional_forward_compatibility:true,critical_event_rejected:true,transaction_rollback:true,delete:true,local_library_isolated:true,target_node:targetNode}));
} finally {
  await Promise.allSettled([source.close(),target.close()]);
}
