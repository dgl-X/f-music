export function createUploadWorker({ db, uploadJobs, uploadProcessor, startOperation, logError = console.error }) {
  let busy = false;
  async function processNext() {
    if (busy) return false;
    busy = true;
    let finish; let succeeded = false;
    try {
      const job = await uploadJobs.claim();
      if (!job) return false;
      finish = startOperation('upload.process');
      const upload = await db.prepare('SELECT * FROM uploads WHERE id=?').get(job.upload_id);
      if (!upload || upload.status !== 'processing') {
        await uploadJobs.complete(job.id);
        succeeded = true;
        return true;
      }
      try {
        const processed = await uploadProcessor.process(upload);
        const importedTrackId = processed.trackId || processed.duplicateId;
        if (importedTrackId) {
          const external = await db.prepare('SELECT * FROM external_imports WHERE upload_id=?').get(upload.id);
          if (external) await db.transaction(async tx => {
            if (processed.status !== 'duplicate') await tx.prepare('UPDATE tracks SET title=?,artist=?,album=?,genre=? WHERE id=?').run(external.title, external.artist, external.album, external.genre, importedTrackId);
            await tx.prepare(`INSERT INTO track_sources(source,source_id,track_id) VALUES(?,?,?)
              ON CONFLICT(source,source_id) DO UPDATE SET track_id=excluded.track_id,imported_at=CURRENT_TIMESTAMP`).run(external.source, external.source_id, importedTrackId);
          });
        }
        await uploadJobs.complete(job.id);
        succeeded = true;
        return true;
      } catch (error) {
        const result = await uploadJobs.failOrRetry(job, error);
        logError(`Ошибка обработки загрузки ${job.upload_id}:`, result.message);
        return false;
      }
    } finally {
      await finish?.(succeeded);
      busy = false;
    }
  }
  return { processNext, isBusy:() => busy };
}
