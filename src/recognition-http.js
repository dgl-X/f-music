function parseCandidates(value){try{return JSON.parse(value||'[]');}catch{return[];}}

function selectedIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isSafeInteger))].slice(0, 500) : [];
}

function optionalMetadata(fields) {
  const source=fields&&typeof fields==='object'?fields:{};
  const has=key=>Object.hasOwn(source,key)&&String(source[key]).trim()!=='';
  if(!['artist','album','genre','year'].some(has))return{error:'Заполните хотя бы одно поле'};
  const values={
    artist:has('artist')?String(source.artist).trim().slice(0,240):null,
    album:has('album')?String(source.album).trim().slice(0,240):null,
    genre:has('genre')?String(source.genre).trim().slice(0,120):null,
    year:has('year')?Number(source.year):null,
  };
  if(values.year!==null&&(!Number.isInteger(values.year)||values.year<1000||values.year>9999))return{error:'Некорректный год'};
  return{values};
}

export function createRecognitionHttpController({db,recognition,readJson,sendJson,runSoon=callback=>callback().catch(()=>{})}){
  const reply=(res,status,value)=>{sendJson(res,status,value);return true;};
  const admin=(res,user)=>user.is_admin?false:reply(res,403,{error:'Доступно только администратору'});
  async function handle(req,res,url,user,apiPrefix='/api'){
    if(url.pathname==='/api/admin/recognition-settings'&&req.method==='GET'){
      if(admin(res,user))return true;const settings=await recognition.settings();return reply(res,200,{enabled:settings.enabled,key_configured:Boolean(settings.clientKey)});
    }
    if(url.pathname==='/api/admin/recognition-settings'&&req.method==='PUT'){
      if(admin(res,user))return true;const body=await readJson(req),enabled=Boolean(body.enabled),keyProvided=Object.hasOwn(body,'client_key'),clientKey=keyProvided?String(body.client_key||'').trim():null;
      if(keyProvided&&clientKey&&!/^[A-Za-z0-9_-]{6,128}$/.test(clientKey))return reply(res,400,{error:'Некорректный Client API key AcoustID'});
      const saved=await recognition.saveSettings({enabled,keyProvided,clientKey});return reply(res,200,{enabled:saved.enabled,key_configured:Boolean(saved.clientKey)});
    }
    if(url.pathname==='/api/recognition'&&req.method==='GET'){
      if(admin(res,user))return true;const [items,states,settings]=await Promise.all([
        db.prepare(`SELECT recognition_jobs.id,recognition_jobs.status,recognition_jobs.confidence,recognition_jobs.suggested_title,recognition_jobs.suggested_artist,recognition_jobs.candidates_json,recognition_jobs.error,recognition_jobs.updated_at,tracks.id AS track_id,tracks.title,tracks.artist,tracks.filename,tracks.duration_seconds,tracks.album,tracks.genre,tracks.year,tracks.cover_key FROM recognition_jobs JOIN tracks ON tracks.id=recognition_jobs.track_id WHERE recognition_jobs.status<>'applied' OR tracks.cover_key IS NULL ORDER BY recognition_jobs.updated_at DESC`).all(),
        db.prepare('SELECT status,count(*) AS count FROM recognition_jobs GROUP BY status').all(),recognition.settings()]);
      return reply(res,200,{enabled:settings.enabled&&Boolean(settings.clientKey),states:Object.fromEntries(states.map(item=>[item.status,Number(item.count)])),items:items.map(item=>({...item,confidence:item.confidence==null?null:Number(item.confidence),duration_seconds:Number(item.duration_seconds||0),candidates:parseCandidates(item.candidates_json),cover_url:item.cover_key?`${apiPrefix}/tracks/${item.track_id}/cover`:null,candidates_json:undefined,cover_key:undefined}))});
    }
    if(url.pathname==='/api/recognition/scan'&&req.method==='POST'){
      if(admin(res,user))return true;const result=await db.prepare(`INSERT INTO recognition_jobs(track_id,status) SELECT id,'queued' FROM tracks WHERE artist='Неизвестный исполнитель' ON CONFLICT(track_id) DO NOTHING`).run();runSoon(recognition.processNext);return reply(res,200,{queued:result.changes});
    }
    if(url.pathname==='/api/recognition/retry-all'&&req.method==='POST'){
      if(admin(res,user))return true;const result=await db.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE status IN ('ignored','unmatched','failed')").run();runSoon(recognition.processNext);return reply(res,200,{queued:result.changes});
    }
    if(url.pathname==='/api/recognition/bulk'&&req.method==='POST'){
      if(admin(res,user))return true;
      const body=await readJson(req),ids=selectedIds(body.ids),action=String(body.action||'');
      if(!ids.length)return reply(res,400,{error:'Не выбраны задания'});
      if(!['apply','retry','ignore','metadata'].includes(action))return reply(res,400,{error:'Некорректное массовое действие'});
      const jobs=await db.prepare('SELECT * FROM recognition_jobs WHERE id = ANY(@ids)').all({ids});
      let updated=0;const covers=[];
      if(action==='metadata'){
        const metadata=optionalMetadata(body.fields);
        if(metadata.error)return reply(res,400,{error:metadata.error});
        const {artist,album,genre,year}=metadata.values;
        await db.transaction(async tx=>{for(const job of jobs){
          await tx.prepare('UPDATE tracks SET artist=COALESCE(?,artist),album=COALESCE(?,album),genre=COALESCE(?,genre),year=COALESCE(?,year) WHERE id=?').run(artist,album,genre,year,job.track_id);
          await tx.prepare("UPDATE recognition_jobs SET status='applied',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;
        }});
      }else await db.transaction(async tx=>{for(const job of jobs){
        if(action==='retry'){await tx.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;}
        else if(action==='ignore'){await tx.prepare("UPDATE recognition_jobs SET status='ignored',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;}
        else {const selected=parseCandidates(job.candidates_json)[0];if(job.status!=='review'||!selected)continue;await tx.prepare("UPDATE tracks SET title=?,artist=?,album=CASE WHEN album='' THEN ? ELSE album END,year=COALESCE(year,?) WHERE id=?").run(selected.title,selected.artist,selected.album||'',selected.year||null,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);if(selected.release_group_id)covers.push([job.track_id,selected.release_group_id]);updated++;}
      }});
      if(covers.length)runSoon(()=>Promise.allSettled(covers.map(([trackId,releaseGroupId])=>recognition.addCover(trackId,releaseGroupId))));
      if(action==='retry')runSoon(recognition.processNext);
      return reply(res,200,{updated,skipped:ids.length-updated});
    }
    const match=/^\/api\/recognition\/(\d+)\/(apply|ignore|retry|manual)$/.exec(url.pathname);
    if(match&&req.method==='POST'){
      if(admin(res,user))return true;
      const job=await db.prepare('SELECT * FROM recognition_jobs WHERE id=?').get(Number(match[1]));
      if(!job)return reply(res,404,{error:'Задание не найдено'});
      const action=match[2];
      if(action==='ignore'){await db.prepare("UPDATE recognition_jobs SET status='ignored',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);return reply(res,200,{ok:true});}
      if(action==='retry'){await db.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);runSoon(recognition.processNext);return reply(res,200,{ok:true});}
      if(action==='manual'){
        const body=await readJson(req),title=String(body.title||'').trim(),artist=String(body.artist||'').trim(),album=String(body.album||'').trim(),genre=String(body.genre||'').trim(),year=body.year===''||body.year==null?null:Number(body.year);
        if(!title||!artist||title.length>240||artist.length>240||album.length>240||genre.length>120)return reply(res,400,{error:'Проверьте название и исполнителя'});
        if(year!==null&&(!Number.isInteger(year)||year<1000||year>9999))return reply(res,400,{error:'Некорректный год'});
        await db.transaction(async tx=>{await tx.prepare('UPDATE tracks SET title=?,artist=?,album=?,genre=?,year=? WHERE id=?').run(title,artist,album,genre,year,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);});
        return reply(res,200,{ok:true});
      }
      if(job.status!=='review')return reply(res,409,{error:'Готового варианта пока нет'});
      const body=await readJson(req),candidates=parseCandidates(job.candidates_json),selected=candidates[Math.max(0,Math.min(candidates.length-1,Number(body.candidate)||0))];
      if(!selected)return reply(res,409,{error:'Вариант не найден'});
      await db.transaction(async tx=>{await tx.prepare("UPDATE tracks SET title=?,artist=?,album=CASE WHEN album='' THEN ? ELSE album END,year=COALESCE(year,?) WHERE id=?").run(selected.title,selected.artist,selected.album||'',selected.year||null,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);});
      if(selected.release_group_id)await recognition.addCover(job.track_id,selected.release_group_id).catch(()=>{});
      return reply(res,200,{ok:true,track_id:job.track_id,title:selected.title,artist:selected.artist});
    }
    return false;
  }
  return{handle};
}
