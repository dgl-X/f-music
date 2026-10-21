import test from 'node:test';
import assert from 'node:assert/strict';
import {createListeningStatistics} from '../src/listening-statistics.js';
import {createListeningStatisticsHttp} from '../src/listening-statistics-http.js';
import {personalStatisticsHtml,administrativeUsageHtml} from '../public/listening-statistics.js';

test('personal statistics scopes every query to authenticated user and does not invent listening time',async()=>{
  const queries=[];
  const db={prepare(sql){return{
    async get(params){queries.push({sql,params});return{recorded_plays:'11',unique_tracks:'2',local_likes:'3',remote_likes:'1',playlists:'2'};},
    async all(params){queries.push({sql,params});return[{id:'one',name:'Artist',title:'Track',artist:'Artist',recorded_plays:'5'}];},
  };}};
  const stats=await createListeningStatistics({db,now:()=>new Date('2026-10-01T00:00:00Z')}).personal(7);
  assert.equal(queries.length,4);
  for(const {sql,params} of queries){assert.match(sql,/@user_id/);assert.deepEqual(params,{user_id:7});assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE/);}
  assert.equal(stats.summary.likes,4);assert.equal(stats.summary.recorded_plays,11);
  assert.equal(stats.listening_seconds,null);assert.equal(stats.period_plays_available,false);
  assert.equal(stats.top_tracks[0].recorded_plays,5);assert.equal(stats.period,'all_time');
});

test('administrative statistics returns aggregates rather than personal tops or session metadata',async()=>{
  const queries=[];const db={prepare(sql){queries.push(sql);return{async get(){return{recorded_plays:'10'};}};}};
  const stats=await createListeningStatistics({db}).administrative();
  assert.equal(queries.length,4);assert.equal(stats.activity.recorded_plays,10);
  assert.equal(stats.listening_seconds,null);assert.equal(stats.top_tracks,undefined);
  assert.doesNotMatch(queries.join('\n'),/ip_address|password_hash|token_hash|client_name|device_name/);
});

test('statistics HTTP rejects non-admin usage without querying data and ignores forged user ids',async()=>{
  const responses=[],calls=[];
  const controller=createListeningStatisticsHttp({statistics:{async personal(id){calls.push(id);return{id};},async administrative(){assert.fail('Unauthorized admin query');}},sendJson(_res,status,value){responses.push({status,value});}});
  assert.equal(await controller.handle({method:'GET'},{},new URL('https://music.test/api/admin/usage'),{id:7,is_admin:0}),true);
  assert.equal(responses[0].status,403);assert.deepEqual(calls,[]);
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/statistics/me?user_id=99'),{id:7,is_admin:0});
  assert.deepEqual(calls,[7]);assert.equal(responses[1].value.id,7);
  assert.equal(await controller.handle({method:'POST'},{},new URL('https://music.test/api/statistics/me'),{id:7}),false);
});

test('statistics HTTP allows admin aggregate and personal remains personal for an administrator',async()=>{
  const responses=[];let id;
  const controller=createListeningStatisticsHttp({statistics:{async personal(value){id=value;return{};},async administrative(){return{activity:{recorded_plays:5}};}},sendJson(_res,status,value){responses.push({status,value});}});
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/admin/usage'),{id:1,is_admin:1});
  assert.equal(responses[0].status,200);assert.equal(responses[0].value.activity.recorded_plays,5);
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/statistics/me'),{id:1,is_admin:1});assert.equal(id,1);
});

test('statistics WEB escapes metadata and explains historical limitations',()=>{
  const html=personalStatisticsHtml({summary:{},top_tracks:[{title:'<img src=x onerror=alert(1)>',artist:'A&B',recorded_plays:5}],top_artists:[],top_albums:[]});
  assert.ok(html.includes('&lt;img'));assert.ok(html.includes('A&amp;B'));assert.ok(!html.includes('<img'));
  assert.match(html,/В старой истории нет всех дат/);assert.match(html,/Топ треков · всё время/);
  const usage=administrativeUsageHtml({activity:{},collections:{},library:{original_bytes:1024**3},sessions:{}});
  assert.match(usage,/1 ГиБ/);assert.match(usage,/не сетевой трафик/);
  assert.match(usage,/Сводка агрегирована/);
});
