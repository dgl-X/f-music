import fs from 'node:fs';
import path from 'node:path';

const VARIANTS={aac_96:{bitrate:'96k',bits:96000},aac_192:{bitrate:'192k',bits:192000}};

export function createTranscodeService({db,storageDir,execute,startOperation=()=>async()=>{},concurrency=2,logError=console.error}){
  const root=path.resolve(storageDir),derivedDir=path.join(root,'derived');
  fs.mkdirSync(derivedDir,{recursive:true,mode:0o750});
  let active=0;

  async function processNext(){
    if(active>=concurrency)return false;
    active++;let job,finish,succeeded=false,temporary;
    try{
      const result=await db.prepare(`UPDATE track_files SET status='processing',updated_at=CURRENT_TIMESTAMP
        WHERE id=(SELECT id FROM track_files WHERE status IN ('queued','retry') ORDER BY priority DESC,updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`).run();
      job=result.rows[0];if(!job)return false;
      finish=startOperation('audio.transcode');
      const variant=VARIANTS[job.variant];
      if(!variant)throw new Error('Неизвестный профиль транскодирования');
      const track=await db.prepare('SELECT storage_key FROM tracks WHERE id=?').get(job.track_id);
      if(!track){await db.prepare("UPDATE track_files SET status='failed',error='Трек удалён',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);return false;}
      const source=path.resolve(root,track.storage_key||'');
      if(!source.startsWith(`${root}${path.sep}`)||!fs.existsSync(source)||!fs.statSync(source).isFile())throw new Error('Исходный файл не найден');
      const shard=String(job.track_id).slice(0,2),targetDir=path.join(derivedDir,job.variant,shard);
      fs.mkdirSync(targetDir,{recursive:true,mode:0o750});
      const storageKey=path.join('derived',job.variant,shard,`${job.track_id}.m4a`),target=path.join(root,storageKey);
      temporary=`${target}.part`;
      fs.rmSync(temporary,{force:true});
      const ok=await execute('ffmpeg',['-loglevel','error','-y','-i',source,'-map','0:a:0','-vn','-c:a','aac','-b:a',variant.bitrate,'-movflags','+faststart','-f','mp4',temporary]);
      if(!ok||!fs.existsSync(temporary))throw new Error('ffmpeg не создал AAC');
      fs.renameSync(temporary,target);
      await db.prepare("UPDATE track_files SET status='ready',mime_type='audio/mp4',codec='aac',bitrate=?,size_bytes=?,storage_key=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(variant.bits,fs.statSync(target).size,storageKey,job.id);
      succeeded=true;return true;
    }catch(error){
      if(temporary)fs.rmSync(temporary,{force:true});
      logError('Ошибка транскодирования:',error);
      if(job)await db.prepare("UPDATE track_files SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(error.message||error).slice(0,1000),job.id).catch(()=>{});
      return false;
    }finally{await finish?.(succeeded);active--;}
  }

  async function recover(){
    await db.prepare("UPDATE track_files SET status='retry',updated_at=CURRENT_TIMESTAMP WHERE status='processing'").run();
    return processNext();
  }

  return{processNext,recover,active:()=>active};
}
