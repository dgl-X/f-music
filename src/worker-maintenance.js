import fs from 'node:fs';
import path from 'node:path';

export function createWorkerMaintenance({db,storageDir,uploadDir,abandonedUploadHours,diagnosticReports,inspectAudio,sha256File,extractCover,normalizedTags,pid=process.pid,nodeVersion=process.version,log=console.log,logError=console.error}){
  const root=path.resolve(storageDir),uploads=path.resolve(uploadDir);

  async function heartbeat(){
    const details=JSON.stringify({pid,version:nodeVersion});
    await db.prepare(`INSERT INTO service_heartbeats(service,started_at,last_seen_at,details_json)
      VALUES('worker',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?) ON CONFLICT(service) DO UPDATE
      SET last_seen_at=CURRENT_TIMESTAMP,details_json=excluded.details_json`).run(details);
  }

  async function cleanupUploads(){
    const result=await db.prepare(`DELETE FROM uploads WHERE status='uploading'
      AND updated_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 hour') RETURNING id`).run(abandonedUploadHours);
    for(const upload of result.rows)fs.rmSync(path.join(uploads,`${upload.id}.part`),{force:true});
    const active=new Set((await db.prepare("SELECT id FROM uploads WHERE status IN ('uploading','processing')").all()).map(row=>`${row.id}.part`));
    const cutoff=Date.now()-abandonedUploadHours*3600000;
    for(const name of fs.readdirSync(uploads)){
      if(!name.endsWith('.part')||active.has(name))continue;
      const file=path.join(uploads,name);
      if(fs.statSync(file).mtimeMs<cutoff)fs.rmSync(file,{force:true});
    }
    await db.prepare("DELETE FROM processing_jobs WHERE status IN ('complete','failed') AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'").run();
    if(result.rows.length)log(`Удалено брошенных загрузок: ${result.rows.length}`);
    return result.rows.length;
  }

  async function cleanupReports(){
    const removed=await diagnosticReports.cleanup();
    if(removed)log(`Удалено старых диагностических отчётов: ${removed}`);
    return removed;
  }

  async function cleanupFederation(){
    await db.prepare('DELETE FROM federation_nonces WHERE expires_at<CURRENT_TIMESTAMP').run();
    await db.prepare("DELETE FROM federation_invitations WHERE (expires_at<CURRENT_TIMESTAMP OR revoked_at IS NOT NULL) AND created_at<CURRENT_TIMESTAMP-INTERVAL '30 days'").run();
  }

  async function enrichTracks(){
    const tracks=await db.prepare('SELECT * FROM tracks WHERE sha256 IS NULL OR cover_checked=0').all();
    for(const track of tracks){
      const file=path.resolve(root,track.storage_key||'');
      if(!file.startsWith(`${root}${path.sep}`)||!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
      try{
        const [metadata,sha256]=await Promise.all([inspectAudio(file),sha256File(file)]);
        if(!metadata)continue;
        const tags=normalizedTags(metadata);let coverKey=track.cover_key;
        if(!coverKey)coverKey=await extractCover(file,track.id);
        const duplicate=await db.prepare('SELECT id FROM tracks WHERE sha256=? AND id<>?').get(sha256,track.id);
        await db.prepare(`UPDATE tracks SET sha256=?, cover_key=?, cover_checked=1, genre=CASE WHEN genre='' THEN ? ELSE genre END,
          year=COALESCE(year,?), track_number=COALESCE(track_number,?), disc_number=COALESCE(disc_number,?) WHERE id=?`).run(
          duplicate?null:sha256,coverKey,tags.genre,tags.year,tags.trackNumber,tags.discNumber,track.id);
      }catch(error){logError(`Не удалось дополнить трек ${track.id}:`,error.message);}
    }
    if(tracks.length)log(`Проверены метаданные существующих треков: ${tracks.length}`);
    return tracks.length;
  }

  return{heartbeat,cleanupUploads,cleanupReports,cleanupFederation,enrichTracks};
}
