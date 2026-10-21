import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { ShuffleNavigator } from '../public/shuffle-navigator.js';
import { AudioMemoryCache } from '../public/audio-cache.js';
import { remotePlaybackActive } from '../public/connect-client.js';
import { connectStatusLabel } from '../public/connect-status.js';
import { PlaybackRequestGate, mediaPlaybackLabel } from '../public/media-playback-client.js';
import { settingsPortalMode, settingsPortalView } from '../public/settings-portal.js';

// Exercise the real app orchestration with a minimal audio element, without
// bootstrapping authentication or claiming a full browser/device field test.
function fixture({portal=false}={}){
  const nodes=new Map(),plays=[],assigned=[];
  const player={paused:true,duration:200,currentTime:0,readyState:0,listeners:[],
    pause(){this.paused=true;},load(){this.readyState=0;},
    play(){plays.push(this.src);this.paused=false;return Promise.resolve();},
    removeAttribute(){this._src='';},getAttribute(){return this._src||null;},
    addEventListener(name,callback){this.listeners.push({name,callback});},
    get src(){return this._src||'';},set src(value){this._src=value;assigned.push(value);},
  };
  const node=id=>{
    if(id==='#player')return player;
    if(!nodes.has(id))nodes.set(id,{style:{},classList:{add(){},remove(){},toggle(){}},textContent:'',value:''});
    return nodes.get(id);
  };
  const code=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const context=vm.createContext({document:{body:{classList:{add(){}}},querySelector:node,querySelectorAll:()=>[]},location:{search:portal?'?android_settings=1':''},settingsPortalMode,settingsPortalView,window:{addEventListener(){}},navigator:{},localStorage:{getItem(){return null;},setItem(){}},URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console,
    ShuffleNavigator,AudioMemoryCache,PlaybackRequestGate,remotePlaybackActive,connectStatusLabel,mediaPlaybackLabel,
    fetch:async()=>({ok:true,status:200,json:async()=>({})}),
  });
  vm.runInContext(code.slice(0,code.lastIndexOf('\nstart().catch'))+`
    const originalScheduleStateSave=scheduleStateSave;
    cancelAudioPrefetch=()=>{};scheduleAudioPrefetch=()=>{};scheduleStateSave=()=>{};
    applyWebGain=()=>{};renderQueue=()=>{};updatePlayingState=()=>{};updateMediaSession=()=>{};renderConnectRemoteState=()=>{};
    globalThis.harness={
      configure(tracks,resolve,rejectCodec=()=>false){queue=tracks;mediaPlaybackClient={resolve,rejectCodec};},
      play:playTrack,toggle:toggleLocalPlayback,
      async settingsIsolation(){await setupConnect();setupListeningTracker();await restorePlayer();return{connectClient,listeningTracker,playerRestored};},
      settingsSave(){originalScheduleStateSave();return stateSaveTimer;},
      settingsSectionBlocked(section){syncBrowserRoute=()=>{};openSettingsSection(section);return settingsSection;},
      sourceError(){return tryCompatibleSource(queue[currentIndex],document.querySelector('#player'));},
      remote(){connectClient={enabled:true,deviceId:'web'};applyConnectState({active_device_id:'remote',playing:true,track_id:''});},
      state(){return{queue,currentIndex,preparing:webMediaPreparing};}
    };
  `,context);
  return{...context.harness,player,plays,assigned,nodes};
}
test('real WEB orchestration in Android settings never creates a Connect client or listening collector',async()=>{
  const h=fixture({portal:true}),result=await h.settingsIsolation();
  assert.equal(result.connectClient,null);assert.equal(result.listeningTracker,null);assert.equal(result.playerRestored,false);assert.equal(h.plays.length,0);
  assert.equal(h.settingsSave(),undefined);
  for(const section of ['duplicates','federation','recognition-queue'])assert.equal(h.settingsSectionBlocked(section),'');
});
const tracks=[{id:'first',title:'First'},{id:'second',title:'Second'}];
const ready=track=>({variant:'original',cache_key:track.id+':original',stream_url:'/api/v1/tracks/'+track.id+'/stream?quality=original&variant=original'});

test('late preparation never starts the previous song or rebuilds the queue',async()=>{
  const h=fixture(),completions=new Map();
  h.configure(tracks,track=>new Promise(resolve=>completions.set(track.id,resolve)));
  const first=h.play(0),second=h.play(1);
  completions.get('second')(ready(tracks[1]));assert.equal(await second,true);
  completions.get('first')(ready(tracks[0]));assert.equal(await first,false);
  assert.equal(h.plays.length,1);assert.match(h.plays[0],/second\/stream/);
  assert.equal(h.state().queue,tracks);assert.equal(h.state().currentIndex,1);
});
test('pause during preparation prevents delayed autoplay',async()=>{
  const h=fixture();let complete;
  h.configure(tracks,()=>new Promise(resolve=>{complete=resolve;}));
  const pending=h.play(0);h.toggle();complete(ready(tracks[0]));
  assert.equal(await pending,false);assert.equal(h.plays.length,0);assert.equal(h.player.src,'');
  assert.equal(h.state().preparing,false);
});
test('Play during paused restoration changes intent without preparing the song twice',async()=>{
  const h=fixture();let complete,calls=0;
  h.configure(tracks,()=>{calls++;return new Promise(resolve=>{complete=resolve;});});
  const pending=h.play(0,false,false,{restore:true,position:30});h.toggle();complete(ready(tracks[0]));
  assert.equal(await pending,true);assert.equal(calls,1);assert.equal(h.plays.length,1);
  h.player.listeners.find(listener=>listener.name==='loadedmetadata').callback();
  assert.equal(h.player.currentTime,30);
});
test('a remote Connect owner cancels an outstanding local preparation',async()=>{
  const h=fixture();let complete;
  h.configure(tracks,()=>new Promise(resolve=>{complete=resolve;}));
  const pending=h.play(0);h.remote();complete(ready(tracks[0]));
  assert.equal(await pending,false);assert.equal(h.plays.length,0);assert.equal(h.player.src,'');
});
test('failed preparation stays visible and never assigns a raw source',async()=>{
  const h=fixture();h.configure(tracks,async()=>{throw new Error('Не удалось подготовить файл');});
  assert.equal(await h.play(0),false);
  assert.equal(h.assigned.length,0);assert.equal(h.plays.length,0);
  assert.match(h.nodes.get('#media-status').textContent,/Не удалось/);
});

test('a browser decoder failure switches only that song to compatible AAC without rebuilding its queue',async()=>{
  const h=fixture();let calls=0,rejected=0;
  h.configure(tracks,async track=>++calls===1?{...ready(track),codec:'flac'}:{variant:'aac_192',codec:'aac',cache_key:track.id+':aac_192',stream_url:'/api/v1/tracks/'+track.id+'/stream?quality=aac_192&variant=aac_192'},()=>{rejected++;return true;});
  await h.play(0);h.player.error={code:4};assert.equal(h.sourceError(),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.plays.length,2);assert.match(h.plays[1],/quality=aac_192/);
  assert.equal(h.state().queue,tracks);assert.equal(rejected,1);
  assert.equal(h.sourceError(),false);
});
