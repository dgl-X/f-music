import crypto from 'node:crypto';
import fs from 'node:fs';

function safeTokenEquals(expected, supplied) {
  return Boolean(expected && supplied && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}

export function createOperationalHttpController({ db, storageDir, workerMode, softwareVersion, metricsToken, registrationEnabled, observability, sendJson, accessStorage = fs.accessSync }) {
  async function handlePublic(req, res, url) {
    if (url.pathname === '/api/health') {
      try {
        await db.prepare('SELECT 1 AS ok').get();
        accessStorage(storageDir, fs.constants.R_OK | fs.constants.W_OK);
        sendJson(res, 200, { status:'ok', database:'ok', storage:'ok', role:workerMode ? 'worker' : 'api' });
      } catch {
        sendJson(res, 503, { status:'degraded' });
      }
      return true;
    }
    if (url.pathname === '/api/setup/status') {
      const [users, settings, heartbeat, registration] = await Promise.all([
        db.prepare('SELECT count(*) count FROM users').get(),
        db.prepare("SELECT value FROM app_settings WHERE key='library_name'").get(),
        db.prepare("SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_seen_at)) AS age_seconds FROM service_heartbeats WHERE service='worker'").get(),
        registrationEnabled(),
      ]);
      const workerAge = heartbeat ? Number(heartbeat.age_seconds) : null;
      sendJson(res, 200, {
        needs_setup:Number(users.count) === 0,
        setup_version:1,
        server_version:softwareVersion,
        library_name:settings?.value || 'Family Music',
        registration_enabled:registration,
        checks:{ database:'ok', storage:'ok', worker:workerAge !== null && workerAge <= 45 ? 'ok' : 'starting' },
      });
      return true;
    }
    if (url.pathname === '/api/metrics/zabbix' && req.method === 'GET') {
      const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!safeTokenEquals(metricsToken, supplied)) {
        sendJson(res, 401, { error:'Недействительный токен метрик' });
        return true;
      }
      const metrics = await observability.metrics();
      sendJson(res, 200, {
        status:metrics.status,
        worker:metrics.worker,
        queues:metrics.queues,
        summary:metrics.summary,
        federation:metrics.federation,
        api:{
          uptime_seconds:metrics.api.uptime_seconds,
          errors_5xx:metrics.api.errors_5xx,
          memory_rss_bytes:metrics.api.memory_rss_bytes,
        },
      });
      return true;
    }
    return false;
  }

  async function handleAdmin(req, res, url, user) {
    if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else sendJson(res, 200, await observability.stats());
      return true;
    }
    if (url.pathname === '/api/admin/stats/recent-errors' && req.method === 'DELETE') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else sendJson(res, 200, { ok:true, ...await observability.clearRecentErrors() });
      return true;
    }
    if (url.pathname === '/api/admin/metrics' && req.method === 'GET') {
      if (!user.is_admin) sendJson(res, 403, { error:'Доступно только администратору' });
      else sendJson(res, 200, await observability.metrics());
      return true;
    }
    return false;
  }

  return { handlePublic, handleAdmin };
}
