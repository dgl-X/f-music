export const UPLOAD_JOB_MAX_ATTEMPTS = 5;

export function uploadRetryDelaySeconds(attempts) {
  return Math.min(300, 5 * (2 ** Math.max(0, Number(attempts) - 1)));
}

export function createUploadJobService({ db, maxAttempts = UPLOAD_JOB_MAX_ATTEMPTS }) {
  async function enqueue({ uploadId, candidateTrackId }) {
    await db.transaction(async tx => {
      await tx.prepare("UPDATE uploads SET status='processing',candidate_track_id=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(candidateTrackId, uploadId);
      await tx.prepare(`INSERT INTO processing_jobs(upload_id,status) VALUES(?,'queued')
        ON CONFLICT(upload_id) DO UPDATE SET status='queued',available_at=CURRENT_TIMESTAMP,started_at=NULL,finished_at=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
        .run(uploadId);
    });
  }

  async function claim() {
    return await db.transaction(async tx => {
      const result = await tx.prepare(`UPDATE processing_jobs SET status='processing',attempts=attempts+1,started_at=CURRENT_TIMESTAMP,finished_at=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=(SELECT id FROM processing_jobs WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id,upload_id,attempts`).run();
      return result.rows[0] ?? null;
    });
  }

  async function complete(jobId) {
    await db.prepare("UPDATE processing_jobs SET status='complete',finished_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(jobId);
  }

  async function failOrRetry(job, error) {
    const message = String(error?.message || error).slice(0, 1000);
    if (Number(job.attempts) >= maxAttempts) {
      await db.transaction(async tx => {
        await tx.prepare("UPDATE processing_jobs SET status='failed',finished_at=CURRENT_TIMESTAMP,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(message, job.id);
        await tx.prepare("UPDATE uploads SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(message, job.upload_id);
      });
      return { status: 'failed', message };
    }
    const delaySeconds = uploadRetryDelaySeconds(job.attempts);
    await db.prepare("UPDATE processing_jobs SET status='retry',available_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),finished_at=NULL,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(delaySeconds, message, job.id);
    return { status: 'retry', delaySeconds, message };
  }

  async function recover() {
    await db.transaction(async tx => {
      await tx.prepare("UPDATE processing_jobs SET status='retry',available_at=CURRENT_TIMESTAMP,started_at=NULL,finished_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='processing'").run();
      await tx.prepare(`INSERT INTO processing_jobs(upload_id,status)
        SELECT id,'queued' FROM uploads WHERE status='processing' ON CONFLICT(upload_id) DO NOTHING`).run();
    });
  }

  return { enqueue, claim, complete, failOrRetry, recover };
}
