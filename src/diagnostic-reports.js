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
  const safeSection=(value,booleans,numbers)=>{
    const result={};if(!value||typeof value!=='object')return result;
    for(const key of booleans)if(typeof value[key]==='boolean')result[key]=value[key];
    for(const key of numbers)if(Number.isFinite(value[key]))result[key]=Math.max(-1,Math.min(Number.MAX_SAFE_INTEGER,value[key]));
    return result;
  };
  if(body.details?.session){
    const value=body.details.session;
    details.session=safeSection(value,[],['started_at_ms','age_ms','event_count','log_bytes','dropped_events']);
    if(typeof value.id==='string'&&/^[0-9a-f-]{36}$/i.test(value.id))details.session.id=value.id;
    if(value.scope==='process')details.session.scope='process';
  }
  if(body.details?.smart_cache)details.smart_cache=safeSection(body.details.smart_cache,['enabled','wifi_only','current_fully_cached'],['depth','limit_bytes','used_bytes','complete_versions','catalog_available','meaningful_listens','cache_hits','offline_skips','offline_stops']);
  if(body.details?.media){
    const value=body.details.media;
    details.media=safeSection(value,['seekable','fully_cached'],['local_state','local_position_ms','local_duration_ms','cache_content_length','cache_cached_bytes','sample_rate','channels','pcm_encoding','bitrate']);
    if(['original','normalized_flac','aac_96','aac_192'].includes(value.selected_variant))details.media.selected_variant=value.selected_variant;
    if(['local','federation','offline','other','unknown'].includes(value.source_kind))details.media.source_kind=value.source_kind;
    for(const key of ['audio_mime','container_mime'])if(typeof value[key]==='string'&&value[key].length<=64&&/^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/.test(value[key]))details.media[key]=value[key];
  }
  const connect=body.details?.connect;
  if(connect&&typeof connect==='object'){
    details.connect={};
    for(const key of ['enabled','remote','command_pending'])if(typeof connect[key]==='boolean')details.connect[key]=connect[key];
    for(const key of ['playback_epoch','last_command_id','last_command_latency_ms','last_contact_age_ms'])if(Number.isFinite(connect[key]))details.connect[key]=Math.max(-1,Math.min(Number.MAX_SAFE_INTEGER,connect[key]));
    if(['connected','reconnecting','error'].includes(connect.connection))details.connect.connection=connect.connection;
  }
  const detailsJson = JSON.stringify(details);
  if (detailsJson.length > 96000) throw reportError('Диагностический журнал слишком большой', 'report_too_large');
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
      try { return reply(res, 201, await reports.create({ userId:user.id, body:await readJson(req, 128 * 1024) })); }
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
