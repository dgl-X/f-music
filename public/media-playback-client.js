const aborted=()=>Object.assign(new Error('Запуск отменён'),{name:'AbortError'});
export function browserPlaybackCodecs(player){
  const types={mp3:'audio/mpeg',aac:'audio/mp4; codecs="mp4a.40.2"',flac:'audio/flac',opus:'audio/ogg; codecs="opus"',vorbis:'audio/ogg; codecs="vorbis"',pcm_s16le:'audio/wav; codecs="1"'};
  return Object.entries(types).filter(([,type])=>Boolean(player?.canPlayType(type))).map(([codec])=>codec);
}
export function mediaCacheKey(track,variant='original'){return `${track.id}:${variant}`;}
export function mediaPlaybackLabel(selection){
  return selection?.variant==='normalized_flac'?'FLAC · без перекодирования'
    : selection?.variant==='aac_192'?'AAC 192 кбит/с · совместимый файл'
    : selection?.variant==='aac_96'?'AAC 96 кбит/с · совместимый файл':'';
}

export class PlaybackRequestGate {
  constructor(){this.generation=0;this.controller=null;}
  begin(){this.cancel();const generation=this.generation,controller=new AbortController();this.controller=controller;return{signal:controller.signal,current:()=>generation===this.generation&&!controller.signal.aborted};}
  cancel(){this.generation++;this.controller?.abort();this.controller=null;}
}

function wait(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(aborted());return;}
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(aborted());};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
    signal?.addEventListener('abort',cancel,{once:true});
  });
}

export class MediaPlaybackClient {
  constructor({api,codecs,now=()=>Date.now(),sleep=wait,timeoutMs=30000}){
    this.api=api;this.codecs=codecs;this.now=now;this.sleep=sleep;this.timeoutMs=timeoutMs;this.legacyUntil=0;this.rejectedCodecs=new Map();
  }
  rejectCodec(trackId,codec){
    if(!this.codecs.includes('aac')||codec==='aac'||!this.codecs.includes(codec))return false;
    const blocked=this.rejectedCodecs.get(trackId)||new Set();if(blocked.has(codec))return false;
    blocked.add(codec);this.rejectedCodecs.set(trackId,blocked);
    if(this.rejectedCodecs.size>256)this.rejectedCodecs.delete(this.rejectedCodecs.keys().next().value);
    return true;
  }
  async request(url,signal){
    const controller=new AbortController();let timedOut=false;
    const cancel=()=>controller.abort();
    if(signal?.aborted)throw aborted();
    signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},8000);
    try{return await this.api(url,{signal:controller.signal});}
    catch(error){if(signal?.aborted)throw aborted();if(timedOut)throw Object.assign(new Error('Сервер не ответил при подготовке аудио'),{code:'media_status_timeout'});throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async resolve(track,{signal,onStatus=()=>{},waitForReady=true,retry=false}={}){
    const legacy=()=>({stream_url:track.remote||track.external_preview?track.stream_url:`/api/v1/tracks/${encodeURIComponent(track.id)}/stream`,variant:'legacy',cache_key:mediaCacheKey(track,'legacy')});
    if(signal?.aborted)throw aborted();
    if(track.remote||track.external_preview||this.now()<this.legacyUntil)return legacy();
    const codecs=this.codecs.filter(codec=>!this.rejectedCodecs.get(track.id)?.has(codec));
    if(!codecs.length)throw Object.assign(new Error('Браузер не сообщил поддерживаемые аудиоформаты'),{code:'media_codec_unsupported'});
    const deadline=this.now()+this.timeoutMs;
    let firstRequest=true;
    for(;;){
      let state;
      try{state=await this.request(`/api/v1/tracks/${encodeURIComponent(track.id)}/playback?quality=original&codecs=${encodeURIComponent(codecs.join(','))}${retry&&firstRequest?'&retry=1':''}`,signal);}
      catch(error){
        if(signal?.aborted)throw aborted();
        if(error.status===404&&error.message==='Маршрут не найден'){this.legacyUntil=this.now()+60000;return legacy();}
        throw error;
      }
      firstRequest=false;
      if(signal?.aborted)throw aborted();
      if(!state||typeof state!=='object')throw new Error('Некорректный ответ подготовки аудио');
      onStatus(state.status);
      if(state.status==='ready'){
        // A server response must never turn an authenticated request into an
        // arbitrary external fetch; use only this track's local stream route.
        const parsed=new URL(state.stream_url,'https://music.invalid');
        if(parsed.origin!=='https://music.invalid'||parsed.pathname!==`/api/v1/tracks/${track.id}/stream`||!['original','normalized_flac','aac_96','aac_192'].includes(state.variant))throw new Error('Некорректный ответ подготовки аудио');
        const expected=state.variant==='normalized_flac'?'original':state.variant;
        if(parsed.searchParams.get('quality')!==expected||parsed.searchParams.get('variant')!==state.variant||parsed.hash)throw new Error('Некорректный вариант подготовки аудио');
        return{...state,stream_url:parsed.pathname+parsed.search,cache_key:mediaCacheKey(track,state.variant)};
      }
      if(state.status==='preparing'){
        if(!waitForReady)return null;
        if(this.now()>=deadline)throw Object.assign(new Error('Подготовка аудио занимает слишком долго. Можно попробовать снова.'),{code:'media_preparation_timeout'});
        await this.sleep(Math.min(3000,Math.max(500,Number(state.retry_after_ms)||1500),Math.max(1,deadline-this.now())),signal);
        continue;
      }
      throw Object.assign(new Error(state.status==='failed'?'Не удалось подготовить совместимый файл':state.status==='unsupported'?'Нет поддерживаемого браузером аудиоформата':'Некорректное состояние подготовки'),{code:state.error_code||'media_preparation_failed'});
    }
  }
}
