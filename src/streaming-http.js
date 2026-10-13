const TRACK_STREAM = /^\/api\/tracks\/([0-9a-f-]+)\/stream$/;
const AAC_VARIANTS = new Set(['aac_96', 'aac_192']);

export function createStreamingHttpController({ db, storageDir, xAccelRedirect, playbackVariant, serveStoredMedia, sendJson }) {
  async function queueVariant(trackId, variant) {
    const ready = await db.prepare("SELECT id FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(trackId, variant);
    if (ready) return;
    await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status) VALUES(?,?,'audio/mp4','aac',?,'queued')
      ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' THEN 'queued' ELSE track_files.status END,updated_at=CURRENT_TIMESTAMP`)
      .run(trackId, variant, variant === 'aac_96' ? 96000 : 192000);
  }

  async function handle(req, res, url) {
    const match = TRACK_STREAM.exec(url.pathname);
    if (!match || req.method !== 'GET') return false;
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(match[1]);
    if (!track) {
      sendJson(res, 404, { error:'Трек не найден' });
      return true;
    }
    const requested = String(url.searchParams.get('quality') || 'original');
    const variant = playbackVariant(requested, track.source_codec);
    const prepareVariant = String(url.searchParams.get('prepare') || '');
    if (AAC_VARIANTS.has(prepareVariant)) await queueVariant(track.id, prepareVariant);
    let selected = null;
    if (variant) {
      selected = await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(track.id, variant);
      if (!selected) await queueVariant(track.id, variant);
      // A missing derivative never blocks playback: serve the original now.
    }
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
