import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API_ORIGIN = 'https://openvk.org';
const MEDIA_HOST = 'cdn.openvk.org';
const MAX_RESULTS = 100;

export function normalizeOpenVkSourceId(value) {
  const match = /^(-?\d+)_(\d+)$/.exec(String(value || '').trim());
  return match ? `${Number(match[1])}_${Number(match[2])}` : null;
}

export function sanitizeOpenVkTrack(item) {
  const sourceId = normalizeOpenVkSourceId(`${item?.owner_id}_${item?.id}`);
  if (!sourceId) return null;
  return {
    source_id: sourceId,
    title: String(item.title || '').trim().slice(0, 500) || 'Без названия',
    artist: String(item.artist || '').trim().slice(0, 500) || 'Неизвестный исполнитель',
    album: String(item.album?.title || item.album || '').trim().slice(0, 500),
    genre: String(item.genre_str || item.genre || '').trim().slice(0, 120),
    duration_seconds: Math.max(0, Number(item.duration) || 0),
    explicit: Boolean(item.explicit),
  };
}

export function validateOpenVkMediaUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || url.username || url.password) return null;
  return url;
}

export function normalizeOpenVkRange(value) {
  if (value == null || value === '') return null;
  const range = String(value).trim();
  return /^bytes=(?:\d+-\d*|-\d+)$/.test(range) ? range : undefined;
}

export function createOpenVkProvider({ db, uploadDir, maxUploadBytes, fetchImpl = fetch }) {
  async function settings() {
    const rows = await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('openvk_enabled','openvk_access_token')").all();
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    return { enabled: values.openvk_enabled === 'true', token: String(values.openvk_access_token || '') };
  }

  async function updateSettings({ enabled, accessToken }) {
    const token = typeof accessToken === 'string'
      ? accessToken.trim().replace(/^access_token=/, '').slice(0, 1024)
      : null;
    await db.transaction(async tx => {
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('openvk_enabled',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled ? 'true' : 'false');
      if (token !== null) {
        await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('openvk_access_token',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(token);
      }
    });
    return settings();
  }

  async function api(method, parameters, token) {
    const url = new URL(`/method/${method}`, API_ORIGIN);
    url.search = new URLSearchParams({ ...parameters, v: '5.131' });
    let response;
    try {
      response = await fetchImpl(url, { headers:{ Authorization:`Bearer ${token}`, 'User-Agent':'F-Music/0.1' }, signal:AbortSignal.timeout(12000) });
    } catch (error) {
      throw Object.assign(new Error('OpenVK сейчас недоступен'), { code:'openvk_unavailable', cause:error });
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.error) {
      const unauthorized = Number(body?.error?.error_code) === 5;
      throw Object.assign(new Error(unauthorized ? 'Токен OpenVK недействителен' : 'OpenVK вернул ошибку'), { code:unauthorized?'openvk_unauthorized':'openvk_error' });
    }
    return body?.response;
  }

  async function search(query, limit = 30, offset = 0) {
    const state = await settings();
    if (!state.enabled || !state.token) throw Object.assign(new Error('Источник OpenVK отключён'), { code:'openvk_disabled' });
    const q = String(query || '').trim().slice(0, 120);
    if (q.length < 2) return { items:[], count:0, offset:0, limit:Math.min(MAX_RESULTS, Math.max(1, Number(limit) || 30)) };
    const boundedLimit = Math.min(MAX_RESULTS, Math.max(1, Number(limit) || 30));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const result = await api('audio.search', { q, count:String(boundedLimit), offset:String(boundedOffset), sort:'2' }, state.token);
    const items = (Array.isArray(result?.items) ? result.items : []).map(sanitizeOpenVkTrack).filter(Boolean);
    return { items, count:Number(result?.count) || items.length, offset:boundedOffset, limit:boundedLimit };
  }

  async function resolve(sourceId, token) {
    const id = normalizeOpenVkSourceId(sourceId);
    if (!id) throw Object.assign(new Error('Некорректный идентификатор OpenVK'), { code:'invalid_openvk_id' });
    const result = await api('audio.getById', { audios:id }, token);
    const item = Array.isArray(result) ? result[0] : Array.isArray(result?.items) ? result.items[0] : null;
    const track = sanitizeOpenVkTrack(item);
    const mediaUrl = validateOpenVkMediaUrl(item?.url);
    if (!track || track.source_id !== id || !mediaUrl) throw Object.assign(new Error('Трек OpenVK недоступен для импорта'), { code:'openvk_track_unavailable' });
    return { track, mediaUrl };
  }

  async function download(mediaUrl, temporary) {
    let response;
    try {
      response = await fetchImpl(mediaUrl, { redirect:'error', headers:{ 'User-Agent':'F-Music/0.1' }, signal:AbortSignal.timeout(180000) });
    } catch (error) {
      throw Object.assign(new Error('Не удалось скачать трек из OpenVK'), { code:'openvk_download_failed', cause:error });
    }
    if (!response.ok || !response.body) throw Object.assign(new Error('OpenVK не отдал аудиофайл'), { code:'openvk_download_failed' });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxUploadBytes) throw Object.assign(new Error('Трек превышает допустимый размер'), { code:'openvk_too_large' });
    const handle = await fs.promises.open(temporary, 'wx', 0o640);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxUploadBytes) throw Object.assign(new Error('Трек превышает допустимый размер'), { code:'openvk_too_large' });
        await handle.write(chunk);
      }
    } finally { await handle.close(); }
    if (!size) throw Object.assign(new Error('OpenVK вернул пустой файл'), { code:'openvk_empty_file' });
    return { size, mimeType:String(response.headers.get('content-type') || 'audio/mpeg').split(';')[0].slice(0, 255) };
  }

  async function preview(sourceId, rangeHeader) {
    const range = normalizeOpenVkRange(rangeHeader);
    if (range === undefined) throw Object.assign(new Error('Некорректный диапазон аудио'), { code:'invalid_openvk_range' });
    const state = await settings();
    if (!state.enabled || !state.token) throw Object.assign(new Error('Источник OpenVK отключён'), { code:'openvk_disabled' });
    const { mediaUrl } = await resolve(sourceId, state.token);
    let response;
    try {
      const headers = { 'User-Agent':'F-Music/0.1' };
      if (range) headers.Range = range;
      response = await fetchImpl(mediaUrl, { redirect:'error', headers, signal:AbortSignal.timeout(180000) });
    } catch (error) {
      throw Object.assign(new Error('Не удалось открыть предпрослушивание OpenVK'), { code:'openvk_download_failed', cause:error });
    }
    if (![200,206].includes(response.status) || !response.body) {
      throw Object.assign(new Error('OpenVK не отдал аудиофайл'), { code:'openvk_download_failed' });
    }
    return response;
  }

  async function importTrack({ sourceId, userId }) {
    const id = normalizeOpenVkSourceId(sourceId);
    if (!id) throw Object.assign(new Error('Некорректный идентификатор OpenVK'), { code:'invalid_openvk_id' });
    const existing = await db.prepare("SELECT track_id FROM track_sources WHERE source='openvk' AND source_id=?").get(id);
    if (existing) return { status:'existing', track_id:existing.track_id };
    const pending = await db.prepare(`SELECT external_imports.upload_id,uploads.status,uploads.track_id
      FROM external_imports JOIN uploads ON uploads.id=external_imports.upload_id
      WHERE external_imports.source='openvk' AND external_imports.source_id=?`).get(id);
    if (pending && pending.status !== 'failed') return { status:pending.status, upload_id:pending.upload_id, track_id:pending.track_id || null };
    if (pending) await db.prepare('DELETE FROM uploads WHERE id=?').run(pending.upload_id);
    const state = await settings();
    if (!state.enabled || !state.token) throw Object.assign(new Error('Источник OpenVK отключён'), { code:'openvk_disabled' });
    const { track, mediaUrl } = await resolve(id, state.token);
    const staging = path.join(uploadDir, `.openvk-${crypto.randomUUID()}.part`);
    try {
      const file = await download(mediaUrl, staging);
      const uploadId = crypto.randomUUID(), candidateTrackId = crypto.randomUUID();
      const safeBase = `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 220) || `openvk-${id}`;
      const target = path.join(uploadDir, `${uploadId}.part`);
      fs.renameSync(staging, target);
      try {
        await db.transaction(async tx => {
          await tx.prepare("INSERT INTO uploads(id,user_id,filename,mime_type,total_bytes,received_bytes,status,candidate_track_id) VALUES(?,?,?,?,?,?,'processing',?)")
            .run(uploadId,userId,`${safeBase}.mp3`,file.mimeType,file.size,file.size,candidateTrackId);
          await tx.prepare("INSERT INTO external_imports(upload_id,source,source_id,title,artist,album,genre) VALUES(?,'openvk',?,?,?,?,?)")
            .run(uploadId,id,track.title,track.artist,track.album,track.genre);
          await tx.prepare("INSERT INTO processing_jobs(upload_id,status) VALUES(?,'queued')").run(uploadId);
        });
      } catch (error) { fs.rmSync(target,{ force:true }); throw error; }
      return { status:'queued', upload_id:uploadId, source_id:id };
    } finally { fs.rmSync(staging,{ force:true }); }
  }

  return { settings, updateSettings, search, preview, importTrack };
}
