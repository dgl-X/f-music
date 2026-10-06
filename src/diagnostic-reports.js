const DETAIL_FIELDS = ['track', 'player', 'queue', 'network', 'storage', 'events'];
const REPORT_STATUSES = new Set(['new', 'viewed', 'fixed']);

function reportError(message, code) {
  return Object.assign(new Error(message), { code });
}

function parseDetails(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

export function normalizeDiagnosticReport(body = {}) {
  const description = String(body.description ?? '').trim().slice(0, 2000);
  if (!description) throw reportError('Опишите, что произошло', 'invalid_report');
  const details = Object.fromEntries(DETAIL_FIELDS
    .filter(key => body.details?.[key] !== undefined)
    .map(key => [key, body.details[key]]));
  const detailsJson = JSON.stringify(details);
  if (detailsJson.length > 40000) throw reportError('Диагностический журнал слишком большой', 'report_too_large');
  return {
    description,
    appVersion:String(body.app_version ?? '').slice(0, 40),
    device:String(body.device ?? '').slice(0, 160),
    androidVersion:String(body.android_version ?? '').slice(0, 80),
    detailsJson,
  };
}

export function createDiagnosticReportsService({ db, retentionDays, fixedRetentionDays }) {
  async function create({ userId, body }) {
    const report = normalizeDiagnosticReport(body);
    const result = await db.prepare(`INSERT INTO diagnostic_reports(user_id,description,app_version,device,android_version,details_json)
      VALUES(?,?,?,?,?,?) RETURNING id,created_at`).run(userId, report.description, report.appVersion, report.device, report.androidVersion, report.detailsJson);
    return { id:Number(result.rows[0].id), created_at:result.rows[0].created_at };
  }

  async function list() {
    const rows = await db.prepare(`SELECT diagnostic_reports.id,diagnostic_reports.description,diagnostic_reports.app_version,
      diagnostic_reports.device,diagnostic_reports.android_version,diagnostic_reports.details_json,diagnostic_reports.status,diagnostic_reports.created_at,diagnostic_reports.updated_at,
      users.username,users.display_name FROM diagnostic_reports JOIN users ON users.id=diagnostic_reports.user_id
      ORDER BY diagnostic_reports.created_at DESC LIMIT 100`).all();
    return rows.map(row => ({ ...row, details:parseDetails(row.details_json), details_json:undefined }));
  }

  async function remove(id) {
    return Boolean((await db.prepare('DELETE FROM diagnostic_reports WHERE id=?').run(id)).changes);
  }

  async function setStatus(id, status) {
    if (!REPORT_STATUSES.has(status)) throw reportError('Некорректный статус', 'invalid_report_status');
    return Boolean((await db.prepare('UPDATE diagnostic_reports SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, id)).changes);
  }

  async function cleanup() {
    const allDays = Math.max(1, Math.floor(retentionDays));
    const fixedDays = Math.max(1, Math.floor(fixedRetentionDays));
    const result = await db.prepare(`DELETE FROM diagnostic_reports
      WHERE created_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
         OR (status='fixed' AND updated_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))`).run(allDays, fixedDays);
    return Number(result.changes || 0);
  }

  return { create, list, remove, setStatus, cleanup };
}

export function createDiagnosticReportsHttpController({ reports, readJson, sendJson }) {
  const reply = (res, status, value) => { sendJson(res, status, value); return true; };
  const adminOnly = (res, user) => user.is_admin ? false : reply(res, 403, { error:'Доступно только администратору' });

  async function handle(req, res, url, user) {
    if (url.pathname === '/api/reports' && req.method === 'POST') {
      try { return reply(res, 201, await reports.create({ userId:user.id, body:await readJson(req, 48 * 1024) })); }
      catch (error) {
        if (error.code === 'invalid_report') return reply(res, 400, { error:error.message });
        if (error.code === 'report_too_large') return reply(res, 413, { error:error.message });
        throw error;
      }
    }
    if (url.pathname === '/api/admin/reports' && req.method === 'GET') {
      if (adminOnly(res, user)) return true;
      return reply(res, 200, { items:await reports.list() });
    }
    const match = /^\/api\/admin\/reports\/(\d+)$/.exec(url.pathname);
    if (!match || !['PATCH', 'DELETE'].includes(req.method)) return false;
    if (adminOnly(res, user)) return true;
    const id = Number(match[1]);
    if (req.method === 'DELETE') return await reports.remove(id)
      ? reply(res, 200, { ok:true }) : reply(res, 404, { error:'Отчёт не найден' });
    const status = String((await readJson(req)).status || '');
    try { return await reports.setStatus(id, status)
      ? reply(res, 200, { ok:true, status }) : reply(res, 404, { error:'Отчёт не найден' }); }
    catch (error) {
      if (error.code === 'invalid_report_status') return reply(res, 400, { error:error.message });
      throw error;
    }
  }

  return { handle };
}
