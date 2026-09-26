export const OPERATION_NAMES = new Set([
  'upload.process',
  'audio.transcode',
  'audio.loudness',
  'federation.sync',
  'federation.import',
]);

export function createOperationMetrics({ db, now = () => performance.now(), logger = console }) {
  async function record(name, durationMs, succeeded) {
    if (!OPERATION_NAMES.has(name)) throw new Error(`Unknown operation metric: ${name}`);
    const duration = Math.max(0, Number(durationMs) || 0);
    try {
      await db.prepare(`INSERT INTO operation_metrics(name,count,error_count,duration_ms_total,duration_ms_max,last_duration_ms,last_succeeded,last_finished_at)
        VALUES(?,1,?,?,?, ?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET count=operation_metrics.count+1,
          error_count=operation_metrics.error_count+excluded.error_count,
          duration_ms_total=operation_metrics.duration_ms_total+excluded.duration_ms_total,
          duration_ms_max=GREATEST(operation_metrics.duration_ms_max,excluded.duration_ms_max),
          last_duration_ms=excluded.last_duration_ms,last_succeeded=excluded.last_succeeded,last_finished_at=CURRENT_TIMESTAMP`)
        .run(name, succeeded ? 0 : 1, duration, duration, duration, succeeded ? 1 : 0);
      return true;
    } catch (error) {
      logger.error('Не удалось сохранить метрику операции:', error.message || error);
      return false;
    }
  }

  function start(name) {
    if (!OPERATION_NAMES.has(name)) throw new Error(`Unknown operation metric: ${name}`);
    const started = now();
    let finished = false;
    return async (succeeded = true) => {
      if (finished) return false;
      finished = true;
      return record(name, now() - started, succeeded);
    };
  }

  return { start, record };
}

export function operationMetricSnapshot(rows) {
  return Object.fromEntries(rows.map(row => [row.name, {
    count:Number(row.count),
    errors:Number(row.error_count),
    duration_ms_average:Number(row.count) ? Number((Number(row.duration_ms_total) / Number(row.count)).toFixed(1)) : 0,
    duration_ms_max:Number(Number(row.duration_ms_max).toFixed(1)),
    last_duration_ms:Number(Number(row.last_duration_ms).toFixed(1)),
    last_succeeded:Boolean(Number(row.last_succeeded)),
    last_finished_at:row.last_finished_at,
  }]));
}
