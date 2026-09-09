import path from 'node:path';

export function loadConfig(env = process.env) {
  const root = path.resolve(env.MUSIC_ROOT ?? process.cwd());
  return {
    host: env.MUSIC_HOST ?? '127.0.0.1',
    port: Number(env.MUSIC_PORT ?? 8095),
    dataDir: path.resolve(env.MUSIC_DATA_DIR ?? path.join(root, 'data')),
    storageDir: path.resolve(env.MUSIC_STORAGE_DIR ?? path.join(root, 'storage')),
    secureCookies: env.MUSIC_SECURE_COOKIES === 'true',
    maxUploadBytes: Number(env.MUSIC_MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024),
    sessionDays: Number(env.MUSIC_SESSION_DAYS ?? 30),
    abandonedUploadHours: Number(env.MUSIC_ABANDONED_UPLOAD_HOURS ?? 24),
    uploadCleanupMinutes: Number(env.MUSIC_UPLOAD_CLEANUP_MINUTES ?? 60),
    diagnosticRetentionDays: Number(env.MUSIC_DIAGNOSTIC_RETENTION_DAYS ?? 90),
    diagnosticFixedRetentionDays: Number(env.MUSIC_DIAGNOSTIC_FIXED_RETENTION_DAYS ?? 30),
    workerPollMs: Number(env.MUSIC_WORKER_POLL_MS ?? 1500),
    xAccelRedirect: env.MUSIC_X_ACCEL_REDIRECT === 'true',
    databaseUrl: env.DATABASE_URL ?? 'postgresql://family_music@127.0.0.1/family_music',
    recognitionEnabled: env.MUSIC_RECOGNITION_ENABLED === 'true',
    acoustIdClientKey: String(env.ACOUSTID_CLIENT_KEY ?? ''),
    metricsToken: String(env.MUSIC_METRICS_TOKEN ?? ''),
  };
}
