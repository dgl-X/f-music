import { parsePlaybackCodecs, PLAYBACK_QUALITIES, selectMediaPlayback } from './media-playback.js';
const TRACK_STREAM = /^\/api\/tracks\/([0-9a-f-]+)\/stream$/;
const AAC_VARIANTS = new Set(['aac_96', 'aac_192']);
const TRACK_PLAYBACK = /^\/api\/tracks\/([0-9a-f-]+)\/playback$/;

export function createStreamingHttpController({ db, storageDir, xAccelRedirect, playbackVariant, serveStoredMedia, sendJson }) {
  async function queueVariant(trackId, variant, retryFailed=true) {
    const ready = await db.prepare("SELECT id FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(trackId, variant);
    if (ready) return;
    await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status) VALUES(?,?,'audio/mp4','aac',?,'queued')
      ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' AND ${retryFailed?'TRUE':'FALSE'} THEN 'queued' ELSE track_files.status END,updated_at=CURRENT_TIMESTAMP`)
      .run(trackId, variant, variant === 'aac_96' ? 96000 : 192000);
  }

  async function resolvePlayback(track,requested,codecs,retry=false){
    const files=await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant IN ('aac_96','aac_192','normalized_flac')").all(track.id);
    const beforeRetry=selectMediaPlayback({requested,sourceCodec:track.source_codec,codecs,files});
    if(retry&&codecs.includes('aac')&&requested!=='source'&&(beforeRetry.status==='failed'||beforeRetry.preparation_status==='failed')){
      const variant=beforeRetry.requested_variant||beforeRetry.variant;
      if(files.some(file=>file.variant===variant&&file.status==='failed')){
        await queueVariant(track.id,variant);
        files.find(file=>file.variant===variant).status='queued';
      }
    }
    const selection=selectMediaPlayback({requested,sourceCodec:track.source_codec,codecs,files});
    const prepare=selection.status==='preparing'?selection.variant:selection.preparation_status==='preparing'?selection.requested_variant:null;
    if(prepare&&!files.some(file=>file.variant===prepare))await queueVariant(track.id,prepare,false);
    if(selection.status==='ready'){
      const selectedFile=files.find(file=>file.variant===selection.variant);
      selection.size_bytes=Number(selectedFile?selectedFile.size_bytes:track.size_bytes)||null;
      const quality=selection.variant==='normalized_flac'?'original':selection.variant==='original'?requested==='source'?'source':'original':selection.variant;
      selection.stream_url=`/api/v1/tracks/${track.id}/stream?quality=${quality}&codecs=${encodeURIComponent(codecs.join(','))}&variant=${selection.variant}`;
    }
    return{selection,file:files.find(file=>file.variant===selection.variant)||null};
  }

  async function handle(req, res, url) {
    const playbackMatch=TRACK_PLAYBACK.exec(url.pathname);
    const match = playbackMatch || TRACK_STREAM.exec(url.pathname);
    if (!match || req.method !== 'GET') return false;
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(match[1]);
    if (!track) {
      sendJson(res, 404, { error:'Трек не найден' });
      return true;
    }
    const requested = String(url.searchParams.get('quality') || 'original');
    if(playbackMatch||url.searchParams.has('codecs')){
      const codecs=parsePlaybackCodecs(url.searchParams.get('codecs'));
      if(!codecs||!PLAYBACK_QUALITIES.has(requested)){
        sendJson(res,400,{error:'Укажите поддерживаемые кодеки и корректное качество',error_code:'invalid_playback_capabilities'});return true;
      }
      const {selection,file}=await resolvePlayback(track,requested,codecs,url.searchParams.get('retry')==='1');
      if(playbackMatch){sendJson(res,200,selection);return true;}
      if(selection.status!=='ready'){
        sendJson(res,selection.status==='unsupported'?415:409,{...selection,error:selection.status==='preparing'?'Совместимый аудиофайл готовится':selection.status==='failed'?'Не удалось подготовить аудиофайл':'Кодек не поддерживается клиентом',error_code:selection.error_code||'media_preparing',retryable:selection.status==='preparing'});return true;
      }
      const expectedVariant=url.searchParams.get('variant');
      if(expectedVariant&&expectedVariant!==selection.variant){
        sendJson(res,409,{error:'Выбранный вариант аудио больше не доступен',error_code:'media_variant_changed',retryable:selection.preparation_status!=='failed'});return true;
      }
      const served=serveStoredMedia(req,res,{storageDir,storageKey:file?.storage_key||track.storage_key,mimeType:file?.mime_type||track.mime_type,variant:selection.variant,xAccelRedirect});
      if(!served)sendJson(res,404,{error:'Файл не найден',error_code:'media_file_missing',retryable:false});
      return true;
    }
    const variant = playbackVariant(requested, track.source_codec);
    const prepareVariant = String(url.searchParams.get('prepare') || '');
    if (AAC_VARIANTS.has(prepareVariant)) await queueVariant(track.id, prepareVariant);
    let selected = null;
    if (variant) {
      selected = await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(track.id, variant);
      if (!selected) await queueVariant(track.id, variant);
      // A missing derivative never blocks playback: serve the original now.
    }
    if(!selected&&requested!=='source')selected=await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant='normalized_flac' AND status='ready'").get(track.id);
    const served = serveStoredMedia(req, res, {
      storageDir,
      storageKey:selected?.storage_key || track.storage_key,
      mimeType:selected?.mime_type || track.mime_type,
      variant:selected?.variant || 'original',
      xAccelRedirect,
    });
    if (!served) sendJson(res, 404, { error:'Файл не найден' });
    return true;
  }

  return { handle };
}
