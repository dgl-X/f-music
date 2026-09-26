import fs from 'node:fs';
import path from 'node:path';
import { federationTrackVisible } from './federation-catalog.js';
import { openFederationStream } from './federation-endpoints.js';
import { externalFederationRequestUri } from './federation-service.js';
import { signFederationRequest, verifyFederationRequest } from './federation-signatures.js';
import { acquireCounter, releaseCounter } from './security.js';

const AUDIO_ROUTE = /^\/federation\/v1\/tracks\/([0-9a-f-]{36})\/stream$/;
const COVER_ROUTE = /^\/federation\/v1\/tracks\/([0-9a-f-]{36})\/cover$/;
const QUALITIES = new Set(['original', 'aac_96', 'aac_192']);

export function parseFederationRange(value, size) {
  if (!value) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;
  let start = 0;
  let end = size - 1;
  if (!match[1] && match[2]) start = Math.max(0, size - Number(match[2]));
  else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Math.min(Number(match[2]), size - 1) : end;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end, status: 206 };
}

export function createFederationMediaService({ db, federation, availability, storageDir, loadIdentity, sendJson, openStream = openFederationStream }) {
  const incomingStreams = new Map();
  const outgoingStreams = new Map();

  async function authenticatedPeer(req, url) {
    const settings = await federation.settings();
    const identity = loadIdentity();
    if (!settings.enabled || !identity) return { error: ['disabled', 404] };
    const nodeId = String(req.headers['x-family-music-node'] || '');
    const peer = await federation.trustedPeer(nodeId);
    if (!peer) return { error: ['untrusted', 403] };
    await verifyFederationRequest({ method:req.method, targetUri:externalFederationRequestUri(req, url), headers:req.headers, publicKey:peer.public_key, expectedNodeId:peer.node_id, consumeNonce:federation.consumeNonce });
    return { identity, peer };
  }

  async function sharedTrack(peer, trackId) {
    const track = await db.prepare('SELECT id,cover_key,album FROM tracks WHERE id=?').get(trackId);
    return federationTrackVisible(track, await federation.exportSettings(peer.node_id)) ? track : null;
  }

  async function serveCover(req, res, url) {
    const match = COVER_ROUTE.exec(url.pathname);
    if (!match || req.method !== 'GET') return false;
    try {
      const auth = await authenticatedPeer(req, url);
      if (auth.error?.[0] === 'disabled') return sendJson(res, 404, { error:{ code:'federation_disabled', message:'Федерация выключена', retryable:false } }), true;
      if (auth.error) return sendJson(res, 403, { error:{ code:'peer_not_trusted', message:'Нода не подключена или отозвана', retryable:false } }), true;
      const track = await sharedTrack(auth.peer, match[1]);
      if (!track) return sendJson(res, 403, { error:{ code:'track_not_shared', message:'Трек не опубликован', retryable:false } }), true;
      if (!track.cover_key) return sendJson(res, 404, { error:{ code:'cover_not_found', message:'Обложка отсутствует', retryable:false } }), true;
      const file = path.resolve(storageDir, track.cover_key);
      if (!file.startsWith(`${path.resolve(storageDir)}${path.sep}`) || !fs.existsSync(file)) return sendJson(res, 404, { error:{ code:'cover_not_found', message:'Файл обложки отсутствует', retryable:false } }), true;
      const size = fs.statSync(file).size;
      res.writeHead(200, { 'Content-Type':'image/jpeg', 'Content-Length':size, 'Cache-Control':'private, max-age=3600' });
      fs.createReadStream(file).pipe(res);
      return true;
    } catch (error) {
      if (!res.headersSent) sendJson(res, 401, { error:{ code:error.code || 'cover_denied', message:error.message || 'Обложка недоступна', retryable:false } });
      else res.destroy();
      return true;
    }
  }

  async function serveAudio(req, res, url) {
    const match = AUDIO_ROUTE.exec(url.pathname);
    if (!match || req.method !== 'GET') return false;
    let peer;
    let acquired = false;
    try {
      const auth = await authenticatedPeer(req, url);
      if (auth.error?.[0] === 'disabled') return sendJson(res, 404, { error:{ code:'federation_disabled', message:'Федерация выключена', retryable:false } }), true;
      if (auth.error) return sendJson(res, 403, { error:{ code:'peer_not_trusted', message:'Нода не подключена или отозвана', retryable:false } }), true;
      peer = auth.peer;
      if (!await sharedTrack(peer, match[1])) return sendJson(res, 403, { error:{ code:'track_not_shared', message:'Трек не опубликован', retryable:false } }), true;
      if (!acquireCounter(incomingStreams, peer.node_id, 4)) return sendJson(res, 429, { error:{ code:'stream_limit', message:'Слишком много одновременных потоков', retryable:true } }), true;
      acquired = true;
      const quality = QUALITIES.has(url.searchParams.get('quality')) ? url.searchParams.get('quality') : 'original';
      const selected = quality === 'original'
        ? await db.prepare('SELECT storage_key,mime_type,size_bytes,sha256 FROM tracks WHERE id=?').get(match[1])
        : await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(match[1], quality);
      if (!selected) {
        await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status,priority) SELECT id,?,'audio/mp4','aac',?,'queued',100 FROM tracks WHERE id=? ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' THEN 'queued' ELSE track_files.status END,priority=GREATEST(track_files.priority,100),updated_at=CURRENT_TIMESTAMP`).run(quality, quality === 'aac_96' ? 96000 : 192000, match[1]);
        releaseCounter(incomingStreams, peer.node_id); acquired = false;
        return sendJson(res, 409, { error:{ code:'variant_not_ready', message:'AAC-вариант готовится, повторите запрос позже', retryable:true } }), true;
      }
      const file = path.resolve(storageDir, selected.storage_key || '');
      if (!file.startsWith(`${path.resolve(storageDir)}${path.sep}`) || !fs.existsSync(file)) {
        releaseCounter(incomingStreams, peer.node_id); acquired = false;
        return sendJson(res, 404, { error:{ code:'file_not_found', message:'Аудиофайл не найден', retryable:false } }), true;
      }
      const size = fs.statSync(file).size;
      const range = parseFederationRange(String(url.searchParams.get('range') || ''), size);
      if (!range) {
        releaseCounter(incomingStreams, peer.node_id); acquired = false;
        res.writeHead(416, { 'Content-Range':`bytes */${size}` }); res.end(); return true;
      }
      res.writeHead(range.status, { 'Content-Type':selected.mime_type || 'audio/mp4', 'X-Music-Variant':quality, 'X-Music-SHA256':selected.sha256 || '', 'Accept-Ranges':'bytes', 'Content-Length':range.end - range.start + 1, 'Cache-Control':'private, no-store', ...(range.status === 206 ? { 'Content-Range':`bytes ${range.start}-${range.end}/${size}` } : {}) });
      const stream = fs.createReadStream(file, { start:range.start, end:range.end });
      let released = false;
      const done = () => { if (!released) { released = true; releaseCounter(incomingStreams, peer.node_id); } };
      stream.once('close', done); stream.once('error', () => res.destroy()); req.once('aborted', () => stream.destroy()); stream.pipe(res);
      return true;
    } catch (error) {
      if (acquired && peer) releaseCounter(incomingStreams, peer.node_id);
      if (!res.headersSent) sendJson(res, 401, { error:{ code:error.code || 'stream_denied', message:error.message || 'Поток отклонён', retryable:false } });
      else res.destroy();
      return true;
    }
  }

  async function remotePeer(nodeId, objectId) {
    return db.prepare("SELECT peer.* FROM federation_peers peer JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id WHERE peer.node_id=? AND remote.object_id=? AND peer.revoked_at IS NULL AND peer.status<>'revoked'").get(nodeId, objectId);
  }

  async function prepareRemote(req, res, { nodeId, objectId, quality }) {
    const peer = await remotePeer(nodeId, objectId);
    if (!peer) return sendJson(res, 404, { error:'Удалённый трек не найден или доступ отозван' });
    if (peer.stream_unavailable_until && new Date(peer.stream_unavailable_until) > new Date()) return sendJson(res, 503, { error:'Удалённая нода временно недоступна', retryable:true });
    try {
      const identity = loadIdentity();
      if (!identity) throw new Error('Локальная идентичность федерации отсутствует');
      const query = new URLSearchParams({ quality, range:'bytes=0-0' });
      const remotePath = `/federation/v1/tracks/${encodeURIComponent(objectId)}/stream?${query}`;
      const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
      const headers = signFederationRequest({ method:'GET', targetUri, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
      const upstream = await openStream(peer.endpoint, remotePath, headers);
      const status = upstream.response.statusCode || 502;
      upstream.response.resume();
      await new Promise(resolve => { upstream.response.once('end', resolve); upstream.response.once('close', resolve); upstream.response.once('error', resolve); });
      if (status === 200 || status === 206) { await availability.recordSuccess(peer.node_id); return sendJson(res, 200, { ready:true, quality }); }
      if (status === 409) { await availability.recordSuccess(peer.node_id); return sendJson(res, 202, { ready:false, quality, retry_after_ms:500 }); }
      if (status >= 500) await availability.recordFailure(peer.node_id, `HTTP ${status}`);
      return sendJson(res, 502, { error:'Исходная нода не смогла подготовить аудио' });
    } catch (error) { await availability.recordFailure(peer.node_id, error.message || error); return sendJson(res, 502, { error:error.message || 'Удалённая нода недоступна' }); }
  }

  async function proxyRemote(req, res, { nodeId, objectId, quality, range }) {
    const peer = await remotePeer(nodeId, objectId);
    if (!peer) return sendJson(res, 404, { error:'Удалённый трек не найден или доступ отозван' });
    if (peer.stream_unavailable_until && new Date(peer.stream_unavailable_until) > new Date()) return sendJson(res, 503, { error:'Удалённая нода временно недоступна', retryable:true });
    if (!acquireCounter(outgoingStreams, peer.node_id, 6)) return sendJson(res, 429, { error:'Слишком много одновременных удалённых потоков' });
    try {
      if (range && !/^bytes=(\d*)-(\d*)$/.test(range)) { releaseCounter(outgoingStreams, peer.node_id); res.writeHead(416); return res.end(); }
      const identity = loadIdentity();
      if (!identity) throw new Error('Локальная идентичность федерации отсутствует');
      const query = new URLSearchParams({ quality }); if (range) query.set('range', range);
      const remotePath = `/federation/v1/tracks/${encodeURIComponent(objectId)}/stream?${query}`;
      const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
      const headers = signFederationRequest({ method:'GET', targetUri, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
      const upstream = await openStream(peer.endpoint, remotePath, headers);
      const status = upstream.response.statusCode || 502;
      if (status === 200 || status === 206) await availability.recordSuccess(peer.node_id);
      else if (status >= 500) await availability.recordFailure(peer.node_id, `HTTP ${status}`);
      const allowed = ['content-type','content-length','content-range','accept-ranges','x-music-variant','x-music-sha256','cache-control'];
      const responseHeaders = Object.fromEntries(allowed.filter(name => upstream.response.headers[name] != null).map(name => [name, upstream.response.headers[name]]));
      res.writeHead(upstream.response.statusCode || 502, responseHeaders);
      let released = false;
      const done = () => { if (!released) { released = true; releaseCounter(outgoingStreams, peer.node_id); } };
      upstream.response.once('close', done); upstream.response.once('error', () => res.destroy()); req.once('aborted', () => upstream.request.destroy());
      res.once('close', () => { if (!res.writableEnded) { upstream.request.destroy(); upstream.response.destroy(); } });
      upstream.response.pipe(res);
    } catch (error) {
      releaseCounter(outgoingStreams, peer.node_id);
      await availability.recordFailure(peer.node_id, error.message || error);
      return sendJson(res, 502, { error:error.message || 'Удалённая нода недоступна' });
    }
  }

  function stats() {
    return {
      incoming_streams:[...incomingStreams.values()].reduce((sum, value) => sum + value, 0),
      outgoing_streams:[...outgoingStreams.values()].reduce((sum, value) => sum + value, 0),
    };
  }

  return { serveCover, serveAudio, prepareRemote, proxyRemote, stats };
}
