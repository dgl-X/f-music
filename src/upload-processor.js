import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_AUDIO_FORMATS = /mp3|flac|ogg|opus|aac|m4a|mp4|wav/;

export function createUploadProcessor({
  db, uploadDir, originalDir, storageDir, inspectAudio, sha256File, validateAudioDecode,
  extractCover, normalizeHybridFlac, normalizedTags, audioCodec, recognitionSettings,
  requiresCompatibilityVariant, randomUUID = () => crypto.randomUUID(),
}) {
  async function markRejected(uploadId, source, error) {
    await db.prepare("UPDATE uploads SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(error, uploadId);
    fs.rmSync(source, { force: true });
    return { status: 'rejected', error };
  }

  async function markDuplicate(uploadId, source, trackId, coverKey = null) {
    fs.rmSync(source, { force: true });
    if (coverKey) fs.rmSync(path.join(storageDir, coverKey), { force: true });
    await db.prepare("UPDATE uploads SET status='duplicate', track_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(trackId, uploadId);
    return { status: 'duplicate', duplicateId: trackId };
  }

  async function process(upload) {
    const temporary = path.join(uploadDir, `${upload.id}.part`);
    const trackId = upload.candidate_track_id || randomUUID();
    const extension = path.extname(upload.filename).toLowerCase().slice(0, 12) || '.audio';
    const shard = trackId.slice(0, 2);
    const destinationDir = path.join(originalDir, shard);
    const storageKey = path.join('originals', shard, `${trackId}${extension}`);
    const destination = path.join(storageDir, storageKey);
    const source = fs.existsSync(temporary) ? temporary : destination;
    if (!fs.existsSync(source)) throw new Error('Временный файл загрузки не найден');

    const [metadata, sourceSha256] = await Promise.all([inspectAudio(source), sha256File(source)]);
    if (!metadata || !SUPPORTED_AUDIO_FORMATS.test(String(metadata.format_name ?? ''))) {
      return await markRejected(upload.id, source, 'Файл не распознан как аудио');
    }
    const validation = await validateAudioDecode(source, metadata.duration);
    if (!validation.valid) return await markRejected(upload.id, source, 'Аудиофайл повреждён или обрезан');

    const duplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sourceSha256);
    if (duplicate) return await markDuplicate(upload.id, source, duplicate.id);

    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o750 });
    const coverKey = await extractCover(source, trackId);
    const normalization = await normalizeHybridFlac(source);
    if (normalization.normalized) fs.renameSync(normalization.output, source);
    const sha256 = normalization.normalized ? await sha256File(source) : sourceSha256;
    if (normalization.normalized) {
      const normalizedDuplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sha256);
      if (normalizedDuplicate) return await markDuplicate(upload.id, source, normalizedDuplicate.id, coverKey);
    }

    const storedSize = fs.statSync(source).size;
    if (source === temporary) fs.renameSync(temporary, destination);
    const tags = normalizedTags(metadata);
    const sourceCodec = audioCodec(metadata);
    const fallbackTitle = path.basename(upload.filename, path.extname(upload.filename));
    const recognition = await recognitionSettings();
    await db.transaction(async tx => {
      await tx.prepare(`INSERT INTO tracks
        (id, owner_id, title, artist, album, filename, mime_type, size_bytes, duration_seconds, storage_key, sha256, cover_key, cover_checked, genre, year, track_number, disc_number, source_codec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
          trackId, upload.user_id, tags.title || fallbackTitle, tags.artist || 'Неизвестный исполнитель',
          tags.album, upload.filename, upload.mime_type, storedSize,
          Number(metadata.duration) || null, storageKey, sha256, coverKey, tags.genre, tags.year, tags.trackNumber, tags.discNumber, sourceCodec
        );
      await tx.prepare("UPDATE uploads SET status='ready', track_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(trackId, upload.id);
      if (recognition.enabled && recognition.clientKey && (!tags.title || !tags.artist)) {
        await tx.prepare("INSERT INTO recognition_jobs(track_id,status) VALUES(?,'queued') ON CONFLICT(track_id) DO NOTHING").run(trackId);
      }
      await tx.prepare("INSERT INTO loudness_jobs(track_id,status) VALUES(?,'queued') ON CONFLICT(track_id) DO NOTHING").run(trackId);
      if (requiresCompatibilityVariant(sourceCodec)) {
        await tx.prepare("INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status,priority) VALUES(?,'aac_192','audio/mp4','aac',192000,'queued',50) ON CONFLICT(track_id,variant) DO NOTHING").run(trackId);
      }
    });
    return { status: 'ready', trackId };
  }

  return { process };
}
