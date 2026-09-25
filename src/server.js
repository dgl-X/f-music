import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { describePublicKeyValue, ensureFederationIdentity, loadFederationIdentity, publicNodeDescriptor } from './federation-identity.js';
import { applyFederationDeltaPage, catalogEvent, decodeCatalogCursor, decodeRemoteReference, encodeCatalogCursor, encodeRemoteReference, federationCatalogRow, federationTrackVisible } from './federation-catalog.js';
import { FEDERATION_PROTOCOL_MINOR, negotiateFederation } from './federation-protocol.js';
import { getFederationJson, openFederationStream, postFederationJson, probeFederationEndpoint } from './federation-endpoints.js';
import { signFederationRequest, signFederationResponse, signPairingConfirmation, verifyFederationRequest, verifyFederationResponse, verifyPairingConfirmation } from './federation-signatures.js';
import { resolveApiRoute } from './routing.js';
import { acquireCounter, hashPassword, parseContentRange, randomToken, releaseCounter, tokenHash } from './security.js';
import { normalizeHybridFlac } from './audio-normalization.js';
import { audioCodec, playbackVariant, requiresCompatibilityVariant } from './audio-compatibility.js';
import { serveStoredMedia } from './media-stream.js';
import { RegistrationLimiter, validateRegistration } from './registration.js';
import { clearSessionCookie, createAuthenticationService, hasValidSessionOrigin, requestIp, requestOriginMatches } from './authentication.js';
import { validateAudioDecode } from './audio-validation.js';
import { createCatalogService } from './catalog-service.js';
import { savePlaybackState } from './playback-state.js';

const config = loadConfig();
const db = await openDatabase(config.databaseUrl);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const softwareVersion = JSON.parse(fs.readFileSync(path.join(publicDir, '../package.json'), 'utf8')).version;
const uploadDir = path.join(config.storageDir, 'uploads');
const originalDir = path.join(config.storageDir, 'originals');
const coverDir = path.join(config.storageDir, 'covers');
const artistDir = path.join(config.storageDir, 'artists');
const albumDir = path.join(config.storageDir, 'albums');
const derivedDir = path.join(config.storageDir, 'derived');
const federationReplicaDir = path.join(config.storageDir, 'federation', 'replicas');
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(originalDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(coverDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(artistDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(albumDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(derivedDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(federationReplicaDir, { recursive: true, mode: 0o750 });

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const registrationLimiter = new RegistrationLimiter();
const authentication = createAuthenticationService({ db, sessionDays: config.sessionDays, secureCookies: config.secureCookies });
const catalog = createCatalogService({ db, apiPrefix: '/api' });
const workerMode = process.argv.includes('--worker');
const processStartedAt = new Date();
const httpMetrics = { requests: 0, errors5xx: 0 };
const sendJson = (res, status, value, extra = {}) => {
  res.writeHead(status, { ...jsonHeaders, ...extra });
  res.end(JSON.stringify(value));
};

async function canEditAlbum(user, albumId){
  return catalog.canEditAlbum({userId:user.id,isAdmin:Boolean(user.is_admin),albumId});
}

async function federationSettings() {
  const rows = await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('federation_enabled','federation_endpoints','federation_export_policy','federation_export_albums','federation_export_collections')").all();
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  let endpoints = [], selectedAlbums = [], selectedCollections = [];
  try { endpoints = JSON.parse(values.federation_endpoints || '[]'); } catch {}
  try { selectedAlbums = JSON.parse(values.federation_export_albums || '[]'); } catch {}
  try { selectedCollections = JSON.parse(values.federation_export_collections || '[]'); } catch {}
  const policy = ['all','albums','collections'].includes(values.federation_export_policy) ? values.federation_export_policy : 'none';
  return { enabled: values.federation_enabled === 'true', endpoints: Array.isArray(endpoints) ? endpoints : [], export_policy: policy,
    selected_albums: Array.isArray(selectedAlbums) ? selectedAlbums.filter(value => typeof value === 'string').slice(0, 1000) : [],
    selected_collections: Array.isArray(selectedCollections) ? selectedCollections.filter(value => typeof value === 'string').slice(0, 1000) : [] };
}

const parseSettingList = value => { try { const parsed=JSON.parse(value||'[]'); return Array.isArray(parsed)?parsed.map(String).slice(0,1000):[]; } catch { return []; } };

async function federationExportSettings(peerNodeId = null) {
  const global = await federationSettings();
  let selected = global;
  if (peerNodeId) {
    const rule = await db.prepare('SELECT policy,selected_albums_json,selected_collections_json FROM federation_peer_export_rules WHERE peer_node_id=?').get(peerNodeId);
    if (rule && rule.policy !== 'inherit') selected = { ...global, export_policy:rule.policy, selected_albums:parseSettingList(rule.selected_albums_json), selected_collections:parseSettingList(rule.selected_collections_json) };
  }
  let selectedTrackIds = [];
  if (selected.export_policy === 'collections' && selected.selected_collections.length) {
    selectedTrackIds = (await db.prepare(`SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])`).all(selected.selected_collections)).map(row=>row.track_id);
  }
  return { ...selected, selected_track_ids:selectedTrackIds };
}

async function appendFederationVisibilityEvents(tx, previousSettings, nextSettings, trackIds = null) {
  const params = Array.isArray(trackIds) && trackIds.length ? trackIds : null;
  const tracks = params
    ? await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks WHERE id=ANY(?::text[]) ORDER BY created_at,id`).all(params)
    : await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks ORDER BY created_at,id`).all();
  const insertEvent = tx.prepare('INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES(?,?,?::jsonb)');
  for (const track of tracks) {
    const wasVisible = federationTrackVisible(track, previousSettings), isVisible = federationTrackVisible(track, nextSettings);
    if (wasVisible === isVisible) continue;
    const payload = isVisible ? { title:track.title,artist:track.artist,album:track.album,genre:track.genre,year:track.year,duration_seconds:track.duration_seconds,track_number:track.track_number,disc_number:track.disc_number,cover_available:Boolean(track.cover_key),created_at:track.created_at,policy_event:true } : { album:track.album,artist:track.artist,policy_event:true };
    await insertEvent.run(isVisible ? 'track.upsert.v1' : 'track.delete.v1', track.id, JSON.stringify(payload));
  }
}

async function appendFederationTrackRefreshEvents(tx, trackIds) {
  const ids=[...new Set((trackIds||[]).map(String))];
  if (!ids.length) return;
  const tracks=await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks WHERE id=ANY(?::text[])`).all(ids);
  const insertEvent=tx.prepare("INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES('track.upsert.v1',?,?::jsonb)");
  for(const track of tracks) await insertEvent.run(track.id,JSON.stringify({title:track.title,artist:track.artist,album:track.album,genre:track.genre,year:track.year,duration_seconds:track.duration_seconds,track_number:track.track_number,disc_number:track.disc_number,cover_available:Boolean(track.cover_key),created_at:track.created_at,policy_event:true}));
}

function validateFederationEndpoints(value) {
  if (!Array.isArray(value) || value.length > 8) throw Object.assign(new Error('Допускается не более 8 адресов ноды'), { status: 400 });
  return value.map((item, index) => {
    const url = String(item?.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw Object.assign(new Error(`Некорректный адрес №${index + 1}`), { status: 400 }); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Object.assign(new Error('Адрес ноды должен использовать HTTPS и не содержать логин'), { status: 400 });
    const scope = item?.scope === 'private' ? 'private' : 'public';
    return { url: parsed.toString().replace(/\/$/, ''), scope, priority: Number.isInteger(item?.priority) ? Math.max(0, Math.min(1000, item.priority)) : index * 10 };
  });
}

async function publicFederation(req, res, url) {
  if (!['/.well-known/family-music', '/federation/v1/node', '/federation/v1/health'].includes(url.pathname) || req.method !== 'GET') return false;
  const settings = await federationSettings();
  const identity = loadFederationIdentity(config.storageDir);
  if (!settings.enabled || !identity) { sendJson(res, 404, { error: { code: 'federation_disabled', message: 'Федерация выключена', retryable: false } }); return true; }
  if (url.pathname === '/federation/v1/health') sendJson(res, 200, { status: 'ok', node_id: identity.node_id, protocol_version: 1 });
  else sendJson(res, 200, publicNodeDescriptor(identity, { softwareVersion, endpoints: settings.endpoints }));
  return true;
}

function externalRequestUri(req, url) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}${url.pathname}${url.search}`;
}

async function consumeFederationNonce(nodeId, nonce, created) {
  await db.prepare('DELETE FROM federation_nonces WHERE expires_at<CURRENT_TIMESTAMP').run();
  const expires = new Date((created + 600) * 1000).toISOString();
  const result = await db.prepare('INSERT INTO federation_nonces(node_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce').run(nodeId, nonce, expires);
  return result.changes === 1;
}

async function acceptFederationPairing(req, res, url) {
  if (url.pathname !== '/federation/v1/pairing/accept' || req.method !== 'POST') return false;
  try {
  const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
  if (!settings.enabled || !identity) { sendJson(res, 404, { error: { code: 'federation_disabled', message: 'Федерация выключена', retryable: false } }); return true; }
  const bytes = await readBytes(req, 64 * 1024); let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { sendJson(res, 400, { error: { code: 'invalid_json', message: 'Некорректный JSON', retryable: false } }); return true; }
  const invitation = await db.prepare(`SELECT * FROM federation_invitations WHERE id=? AND secret_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP`).get(body.invitation_id, tokenHash(String(body.secret || '')));
  if (!invitation) { sendJson(res, 403, { error: { code: 'invalid_invitation', message: 'Приглашение недействительно или истекло', retryable: false } }); return true; }
  const remote = body.node || {}, described = describePublicKeyValue(String(remote.public_key?.value || ''));
  if (described.nodeId !== remote.node_id) { sendJson(res, 400, { error: { code: 'node_id_mismatch', message: 'node_id не соответствует публичному ключу', retryable: false } }); return true; }
  if (remote.node_id === identity.node_id) { sendJson(res, 409, { error: { code: 'self_pairing', message: 'Нельзя подключить ноду саму к себе', retryable: false } }); return true; }
  await verifyFederationRequest({ method: req.method, targetUri: externalRequestUri(req, url), body: bytes, headers: req.headers, publicKey: remote.public_key.value, expectedNodeId: remote.node_id, consumeNonce: consumeFederationNonce });
  const remoteEndpoint = remote.endpoints?.find(item => item.scope === 'public')?.url;
  if (!remoteEndpoint) { sendJson(res, 400, { error: { code: 'endpoint_required', message: 'У подключаемой ноды нет публичного endpoint', retryable: false } }); return true; }
  const negotiation = negotiateFederation(remote, ['pairing.v1']);
  const remoteMinor = negotiation.minor ?? 0, status = negotiation.status;
  const used = await db.prepare('UPDATE federation_invitations SET used_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL RETURNING id').run(invitation.id);
  if (!used.changes) { sendJson(res, 409, { error: { code: 'invitation_used', message: 'Приглашение уже использовано', retryable: false } }); return true; }
  await db.prepare(`INSERT INTO federation_peers(node_id,label,public_key,endpoint,status,protocol_major,protocol_minor,capabilities_json,last_seen_at)
    VALUES(?,?,?,?,?,1,?,?,CURRENT_TIMESTAMP) ON CONFLICT(node_id) DO UPDATE SET public_key=excluded.public_key,endpoint=excluded.endpoint,status=excluded.status,protocol_minor=excluded.protocol_minor,capabilities_json=excluded.capabilities_json,updated_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,revoked_at=NULL`)
    .run(remote.node_id, String(remote.label || '').slice(0, 120), remote.public_key.value, remoteEndpoint, status, Math.max(0, remoteMinor), JSON.stringify(remote.capabilities || {}));
  const node = publicNodeDescriptor(identity, { softwareVersion, endpoints: settings.endpoints });
  const confirmationValues = { invitationId: invitation.id, requesterNodeId: remote.node_id, issuerNodeId: identity.node_id, challenge: String(body.challenge || '') };
  sendJson(res, 200, { node, status, confirmation: signPairingConfirmation(confirmationValues, identity.private_key_pem) }); return true;
  } catch (error) {
    const clientCodes = new Set(['node_mismatch', 'invalid_nonce', 'invalid_signature', 'clock_skew', 'digest_mismatch', 'replay_detected']);
    const status = clientCodes.has(error.code) ? 401 : 400;
    sendJson(res, status, { error: { code: error.code || 'invalid_pairing_request', message: error.message || 'Некорректный запрос pairing', retryable: false } });
    return true;
  }
}

async function federationCatalog(req, res, url) {
  if (url.pathname !== '/federation/v1/catalog/delta' || req.method !== 'GET') return false;
  try {
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) { sendJson(res, 404, { error: { code: 'federation_disabled', message: 'Федерация выключена', retryable: false } }); return true; }
    const remoteNodeId = String(req.headers['x-family-music-node'] || '');
    const peer = await db.prepare("SELECT node_id,public_key FROM federation_peers WHERE node_id=? AND status IN ('compatible','limited') AND revoked_at IS NULL").get(remoteNodeId);
    if (!peer) { sendJson(res, 403, { error: { code: 'peer_not_trusted', message: 'Нода не подключена или отозвана', retryable: false } }); return true; }
    await verifyFederationRequest({ method: req.method, targetUri: externalRequestUri(req, url), headers: req.headers, publicKey: peer.public_key, expectedNodeId: peer.node_id, consumeNonce: consumeFederationNonce });
    const after = decodeCatalogCursor(url.searchParams.get('cursor')), limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 500));
    const rows = await db.prepare(`SELECT events.revision,events.event_type,events.object_id,events.payload_json,events.occurred_at,tracks.album AS current_album
      FROM federation_catalog_events events LEFT JOIN tracks ON tracks.id=events.object_id WHERE events.revision>? ORDER BY events.revision LIMIT ?`).all(after, limit + 1);
    const exportSettings = await federationExportSettings(peer.node_id);
    const rawPage = rows.slice(0, limit), page = rawPage.map(row => federationCatalogRow(row, exportSettings)), hasMore = rows.length > limit, lastRevision = rawPage.length ? Number(rawPage.at(-1).revision) : after;
    const body = Buffer.from(JSON.stringify({ protocol_version: 1, producer_minor: FEDERATION_PROTOCOL_MINOR, min_reader_minor: 0, items: page.map(row => catalogEvent(row, identity.node_id)), next_cursor: encodeCatalogCursor(lastRevision), has_more: hasMore }));
    res.writeHead(200, { ...jsonHeaders, ...signFederationResponse(body, identity.node_id, identity.private_key_pem) }); res.end(body);
    return true;
  } catch (error) {
    const unauthorized = ['node_mismatch','invalid_nonce','invalid_signature','clock_skew','digest_mismatch','replay_detected'].includes(error.code);
    sendJson(res, unauthorized ? 401 : 400, { error: { code: error.code || 'catalog_request_failed', message: error.message || 'Некорректный запрос каталога', retryable: false } });
    return true;
  }
}

async function federationNotify(req, res, url) {
  if (url.pathname !== '/federation/v1/catalog/notify' || req.method !== 'POST') return false;
  try {
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) { sendJson(res, 404, { error: { code: 'federation_disabled', message: 'Федерация выключена', retryable: false } }); return true; }
    const bytes = await readBytes(req, 16 * 1024), remoteNodeId = String(req.headers['x-family-music-node'] || '');
    const peer = await db.prepare("SELECT node_id,public_key FROM federation_peers WHERE node_id=? AND status IN ('compatible','limited') AND revoked_at IS NULL").get(remoteNodeId);
    if (!peer) { sendJson(res, 403, { error: { code: 'peer_not_trusted', message: 'Нода не подключена или отозвана', retryable: false } }); return true; }
    await verifyFederationRequest({ method: req.method, targetUri: externalRequestUri(req, url), body: bytes, headers: req.headers, publicKey: peer.public_key, expectedNodeId: peer.node_id, consumeNonce: consumeFederationNonce });
    let body; try { body=JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('Некорректный JSON notify'), { code: 'invalid_json' }); }
    const revision=Number(body.latest_revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw Object.assign(new Error('Некорректная latest_revision'), { code: 'invalid_revision' });
    await db.prepare('UPDATE federation_peers SET remote_latest_revision=GREATEST(remote_latest_revision,?),next_sync_at=LEAST(next_sync_at,CURRENT_TIMESTAMP),last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE node_id=?').run(revision,peer.node_id);
    sendJson(res, 202, { accepted: true, latest_revision: revision }); return true;
  } catch (error) {
    const unauthorized=['node_mismatch','invalid_nonce','invalid_signature','clock_skew','digest_mismatch','replay_detected'].includes(error.code);
    sendJson(res,unauthorized?401:400,{ error:{ code:error.code||'notify_failed',message:error.message||'Некорректный notify',retryable:false } }); return true;
  }
}

const incomingFederationStreams=new Map(),outgoingFederationStreams=new Map();

async function federationCover(req,res,url){
  const match=/^\/federation\/v1\/tracks\/([0-9a-f-]{36})\/cover$/.exec(url.pathname);
  if(!match||req.method!=='GET')return false;
  try{
    const settings=await federationSettings(),identity=loadFederationIdentity(config.storageDir);
    if(!settings.enabled||!identity)return sendJson(res,404,{error:{code:'federation_disabled',message:'Федерация выключена',retryable:false}}),true;
    const remoteNodeId=String(req.headers['x-family-music-node']||''),peer=await db.prepare("SELECT node_id,public_key FROM federation_peers WHERE node_id=? AND status IN ('compatible','limited') AND revoked_at IS NULL").get(remoteNodeId);
    if(!peer)return sendJson(res,403,{error:{code:'peer_not_trusted',message:'Нода не подключена или отозвана',retryable:false}}),true;
    await verifyFederationRequest({method:req.method,targetUri:externalRequestUri(req,url),headers:req.headers,publicKey:peer.public_key,expectedNodeId:peer.node_id,consumeNonce:consumeFederationNonce});
    const track=await db.prepare('SELECT id,cover_key,album FROM tracks WHERE id=?').get(match[1]);
    if(!federationTrackVisible(track,await federationExportSettings(peer.node_id)))return sendJson(res,403,{error:{code:'track_not_shared',message:'Трек не опубликован',retryable:false}}),true;
    if(!track?.cover_key)return sendJson(res,404,{error:{code:'cover_not_found',message:'Обложка отсутствует',retryable:false}}),true;
    const file=path.resolve(config.storageDir,track.cover_key);
    if(!file.startsWith(config.storageDir+path.sep)||!fs.existsSync(file))return sendJson(res,404,{error:{code:'cover_not_found',message:'Файл обложки отсутствует',retryable:false}}),true;
    const size=fs.statSync(file).size;
    res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':size,'Cache-Control':'private, max-age=3600'});
    fs.createReadStream(file).pipe(res);return true;
  }catch(error){if(!res.headersSent)sendJson(res,401,{error:{code:error.code||'cover_denied',message:error.message||'Обложка недоступна',retryable:false}});else res.destroy();return true;}
}

async function federationAudio(req,res,url){
  const match=/^\/federation\/v1\/tracks\/([0-9a-f-]{36})\/stream$/.exec(url.pathname);
  if(!match||req.method!=='GET')return false;
  let peer, acquired = false;
  try{
    const settings=await federationSettings(),identity=loadFederationIdentity(config.storageDir);
    if(!settings.enabled||!identity)return sendJson(res,404,{error:{code:'federation_disabled',message:'Федерация выключена',retryable:false}}),true;
    const remoteNodeId=String(req.headers['x-family-music-node']||'');peer=await db.prepare("SELECT node_id,public_key FROM federation_peers WHERE node_id=? AND status IN ('compatible','limited') AND revoked_at IS NULL").get(remoteNodeId);
    if(!peer)return sendJson(res,403,{error:{code:'peer_not_trusted',message:'Нода не подключена или отозвана',retryable:false}}),true;
    await verifyFederationRequest({method:req.method,targetUri:externalRequestUri(req,url),headers:req.headers,publicKey:peer.public_key,expectedNodeId:peer.node_id,consumeNonce:consumeFederationNonce});
    const exportedTrack=await db.prepare('SELECT id,album FROM tracks WHERE id=?').get(match[1]);
    if(!federationTrackVisible(exportedTrack,await federationExportSettings(peer.node_id)))return sendJson(res,403,{error:{code:'track_not_shared',message:'Трек не опубликован',retryable:false}}),true;
    if(!acquireCounter(incomingFederationStreams,peer.node_id,4))return sendJson(res,429,{error:{code:'stream_limit',message:'Слишком много одновременных потоков',retryable:true}}),true;
    acquired = true;
    const quality=['original','aac_96','aac_192'].includes(url.searchParams.get('quality'))?url.searchParams.get('quality'):'original';
    const selected=quality==='original'?await db.prepare('SELECT storage_key,mime_type,size_bytes,sha256 FROM tracks WHERE id=?').get(match[1]):await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(match[1],quality);
    if(!selected){await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status,priority) SELECT id,?,'audio/mp4','aac',?,'queued',100 FROM tracks WHERE id=? ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' THEN 'queued' ELSE track_files.status END,priority=GREATEST(track_files.priority,100),updated_at=CURRENT_TIMESTAMP`).run(quality,quality==='aac_96'?96000:192000,match[1]);releaseCounter(incomingFederationStreams,peer.node_id);acquired=false;return sendJson(res,409,{error:{code:'variant_not_ready',message:'AAC-вариант готовится, повторите запрос позже',retryable:true}}),true;}
    const file=path.resolve(config.storageDir,selected.storage_key||'');if(!file.startsWith(config.storageDir+path.sep)||!fs.existsSync(file)){releaseCounter(incomingFederationStreams,peer.node_id);acquired=false;return sendJson(res,404,{error:{code:'file_not_found',message:'Аудиофайл не найден',retryable:false}}),true;}
    const size=fs.statSync(file).size,range=String(url.searchParams.get('range')||''),rangeMatch=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0,end=size-1,status=200;
    if(range){if(!rangeMatch){releaseCounter(incomingFederationStreams,peer.node_id);acquired=false;res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return true;}if(!rangeMatch[1]&&rangeMatch[2])start=Math.max(0,size-Number(rangeMatch[2]));else{start=rangeMatch[1]?Number(rangeMatch[1]):0;end=rangeMatch[2]?Math.min(Number(rangeMatch[2]),size-1):end;}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){releaseCounter(incomingFederationStreams,peer.node_id);acquired=false;res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return true;}status=206;}
    res.writeHead(status,{'Content-Type':selected.mime_type||'audio/mp4','X-Music-Variant':quality,'X-Music-SHA256':selected.sha256||'', 'Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'private, no-store',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    const stream=fs.createReadStream(file,{start,end});let released=false;const done=()=>{if(released)return;released=true;releaseCounter(incomingFederationStreams,peer.node_id);};stream.once('close',done);stream.once('error',()=>res.destroy());req.once('aborted',()=>stream.destroy());stream.pipe(res);return true;
  }catch(error){if(acquired&&peer)releaseCounter(incomingFederationStreams,peer.node_id);if(!res.headersSent)sendJson(res,401,{error:{code:error.code||'stream_denied',message:error.message||'Поток отклонён',retryable:false}});else res.destroy();return true;}
}

let federationSyncBusy = false;
async function syncFederationCatalogs() {
  if (federationSyncBusy) return;
  federationSyncBusy = true;
  try {
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) return;
    const peers = await db.prepare("SELECT * FROM federation_peers WHERE status IN ('compatible','limited') AND revoked_at IS NULL AND next_sync_at<=CURRENT_TIMESTAMP ORDER BY next_sync_at LIMIT 4").all();
    for (const peer of peers) try {
      let cursor = peer.catalog_cursor || '', pages = 0, hasMore = true;
      while (hasMore && pages++ < 4) {
        const query = new URLSearchParams({ limit: '500' }); if (cursor) query.set('cursor', cursor);
        const path = `/federation/v1/catalog/delta?${query}`, targetUri = `${peer.endpoint.replace(/\/$/, '')}${path}`;
        const headers = signFederationRequest({ method: 'GET', targetUri, nodeId: identity.node_id, privateKeyPem: identity.private_key_pem });
        const response = await getFederationJson(peer.endpoint, path, headers);
        if (!verifyFederationResponse(response.bytes, response.headers, peer.node_id, peer.public_key)) throw Object.assign(new Error('Подпись ответа каталога не прошла проверку'), { code: 'invalid_response_signature' });
        const page = response.body;
        const removedReplicas = await applyFederationDeltaPage(db, peer.node_id, page);
        for (const removed of removedReplicas) {
          if (removed.storageKey) { const file=path.resolve(config.storageDir,removed.storageKey);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true}); }
          fs.rmSync(federationReplicaPaths(peer.node_id,removed.objectId).temporaryPath,{force:true});
        }
        cursor = page.next_cursor; hasMore = Boolean(page.has_more);
      }
    } catch (error) {
      const failures = Number(peer.sync_failures || 0) + 1, delay = Math.min(3600, 15 * 2 ** Math.min(8, failures - 1)) + Math.floor(Math.random() * 10);
      await db.prepare("UPDATE federation_peers SET sync_failures=?,sync_error=?,next_sync_at=CURRENT_TIMESTAMP+(?*INTERVAL '1 second'),updated_at=CURRENT_TIMESTAMP WHERE node_id=?").run(failures,String(error.message||error).slice(0,1000),delay,peer.node_id);
    }
  } finally { federationSyncBusy = false; }
}

let federationNotifyBusy = false;
async function notifyFederationPeers() {
  if (federationNotifyBusy) return;
  federationNotifyBusy = true;
  try {
    const settings=await federationSettings(),identity=loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) return;
    const head=Number((await db.prepare('SELECT COALESCE(max(revision),0) AS revision FROM federation_catalog_events').get()).revision);
    const peers=await db.prepare("SELECT * FROM federation_peers WHERE status IN ('compatible','limited') AND revoked_at IS NULL AND last_notified_revision<? AND next_notify_at<=CURRENT_TIMESTAMP ORDER BY next_notify_at LIMIT 8").all(head);
    for (const peer of peers) try {
      const path='/federation/v1/catalog/notify',targetUri=`${peer.endpoint.replace(/\/$/,'')}${path}`;
      const payload=JSON.stringify({ latest_revision:head,changed_at:new Date().toISOString() });
      const headers=signFederationRequest({method:'POST',targetUri,body:payload,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem});
      await postFederationJson(peer.endpoint,path,payload,headers);
      await db.prepare('UPDATE federation_peers SET last_notified_revision=?,next_notify_at=CURRENT_TIMESTAMP,notify_failures=0,notify_error=NULL WHERE node_id=?').run(head,peer.node_id);
    } catch(error) {
      const failures=Number(peer.notify_failures||0)+1,delay=Math.min(3600,15*2**Math.min(8,failures-1))+Math.floor(Math.random()*10);
      await db.prepare("UPDATE federation_peers SET notify_failures=?,notify_error=?,next_notify_at=CURRENT_TIMESTAMP+(?*INTERVAL '1 second') WHERE node_id=?").run(failures,String(error.message||error).slice(0,1000),delay,peer.node_id);
    }
  } finally { federationNotifyBusy=false; }
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

async function readBytes(req, limit) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw Object.assign(new Error('Файл слишком большой'), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Файл слишком большой'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('Пустой файл'), { status: 400 });
  return Buffer.concat(chunks);
}

async function currentUser(req) {
  return authentication.currentUser({ cookieHeader:req.headers.cookie, deviceName:req.headers['x-device-name'], clientName:req.headers['x-client-name'], ip:requestIp(req) });
}

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) sendJson(res, 401, { error: 'Требуется авторизация' });
  return user;
}

function safeFilename(name) {
  return path.basename(String(name ?? '')).replace(/[\x00-\x1f]/g, '').slice(0, 240);
}

function storageStats(directory) {
  let bytes = 0, files = 0;
  if (!fs.existsSync(directory)) return { bytes, files };
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile()) { files++; bytes += fs.statSync(item).size; }
    }
  }
  return { bytes, files };
}

function storedFileExists(storageKey) {
  if (!storageKey) return false;
  const file = path.resolve(config.storageDir, storageKey);
  return file.startsWith(config.storageDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
}

function inspectAudio(file) {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(output);
        resolve(parsed.format ? { ...parsed.format, streams: parsed.streams ?? [] } : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function runProcess(command, args) {
  return new Promise(resolve => {
    const proc = spawn(command, args, { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function captureProcess(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args); let output = '', errors = '';
    proc.stdout.on('data', chunk => { output += chunk; }); proc.stderr.on('data', chunk => { errors += chunk; });
    proc.on('close', code => code === 0 ? resolve(output) : reject(new Error(errors.trim() || `${command}: код ${code}`)));
    proc.on('error', reject);
  });
}

function captureProcessOutput(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args); let output = '';
    proc.stdout.on('data', chunk => { output += chunk; }); proc.stderr.on('data', chunk => { output += chunk; });
    proc.on('close', code => code === 0 ? resolve(output) : reject(new Error(output.trim() || `${command}: код ${code}`)));
    proc.on('error', reject);
  });
}

function parseLoudness(output) {
  const blocks = [...String(output).matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)];
  if (!blocks.length) throw new Error('ffmpeg не вернул измерение loudnorm');
  const measured = JSON.parse(blocks.at(-1)[0]);
  const integrated = Number(measured.input_i), peak = Number(measured.input_tp), range = Number(measured.input_lra);
  if (![integrated, peak, range].every(Number.isFinite)) throw new Error('Некорректное измерение громкости');
  const gain = Math.max(-12, Math.min(12, -14 - integrated, -1 - peak));
  return { integrated, peak, range, gain: Math.round(gain * 100) / 100 };
}

const loudnessConcurrency = 2;
let loudnessActive = 0;
async function processNextLoudness() {
  if (loudnessActive >= loudnessConcurrency) return;
  loudnessActive++; let job;
  try {
    const result = await db.prepare(`UPDATE loudness_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM loudness_jobs WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`).run();
    job = result.rows[0]; if (!job) return;
    const track = await db.prepare('SELECT storage_key FROM tracks WHERE id=?').get(job.track_id);
    if (!track || !storedFileExists(track.storage_key)) throw new Error('Исходный файл не найден');
    const output = await captureProcessOutput('ffmpeg', ['-hide_banner','-nostats','-i',path.join(config.storageDir,track.storage_key),'-map','0:a:0','-af','loudnorm=I=-14:TP=-1:LRA=11:print_format=json','-f','null','-']);
    const value = parseLoudness(output);
    await db.prepare(`UPDATE loudness_jobs SET status='ready',integrated_lufs=?,true_peak_db=?,loudness_range_lu=?,recommended_gain_db=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(value.integrated,value.peak,value.range,value.gain,job.id);
  } catch (error) {
    const message = String(error.message || error).slice(-2000), attempts = Number(job?.attempts || 0);
    if (job) await db.prepare(`UPDATE loudness_jobs SET status=?,available_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(attempts >= 3 ? 'failed' : 'retry', Math.min(900, 30 * (2 ** Math.max(0,attempts-1))), message, job.id).catch(()=>{});
    console.error('Ошибка анализа громкости:', message);
  } finally { loudnessActive--; }
}

function pumpLoudness() {
  for (let slot=0;slot<loudnessConcurrency;slot++) processNextLoudness().catch(error=>console.error('Ошибка loudness worker:',error));
}

let recognitionBusy = false;
async function processNextRecognition() {
  if (recognitionBusy) return;
  const settings = await recognitionSettings();
  if (!settings.enabled || !settings.clientKey) return;
  recognitionBusy = true; let job;
  try {
    const result = await db.prepare(`UPDATE recognition_jobs SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM recognition_jobs WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`).run();
    job = result.rows[0]; if (!job) return;
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(job.track_id);
    if (!track || !storedFileExists(track.storage_key)) throw new Error('Исходный файл не найден');
    const fingerprint = JSON.parse(await captureProcess('fpcalc', ['-json', path.join(config.storageDir, track.storage_key)]));
    const body = new URLSearchParams({ client: settings.clientKey, duration: String(Math.round(fingerprint.duration)), fingerprint: fingerprint.fingerprint, meta: 'recordings releases releasegroups' });
    const response = await fetch('https://api.acoustid.org/v2/lookup', { method:'POST', body, signal:AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`AcoustID: HTTP ${response.status}`);
    const lookup = await response.json(); if (lookup.status !== 'ok') throw new Error(`AcoustID: ${lookup.error?.message || 'ошибка'}`);
    const candidates = [];
    for (const result of lookup.results || []) for (const recording of result.recordings || []) {
      const artist = (recording.artists || []).map(item => item.name).filter(Boolean).join(', '), title = String(recording.title || '').trim();
      if (!artist || !title) continue;
      const difference = recording.duration == null ? 999 : Math.abs(Number(recording.duration) - Number(track.duration_seconds || fingerprint.duration));
      const releaseGroups = (recording.releasegroups || []).filter(group => {
        const secondary = (group.secondarytypes || []).map(value => String(value).toLowerCase());
        return !secondary.some(value => ['compilation','dj-mix','remix','live'].includes(value)) && !(group.artists || []).some(item => item.name === 'Various Artists');
      }).map(group => {
        const years = (group.releases || []).map(release => Number(release.date?.year)).filter(Number.isFinite);
        return { album:group.title || '', year:years.length ? Math.min(...years) : null, release_group_id:group.id, type:String(group.type || '').toLowerCase() };
      }).sort((a,b) => ({album:0,ep:1,single:2}[a.type] ?? 3)-({album:0,ep:1,single:2}[b.type] ?? 3) || (a.year || 9999)-(b.year || 9999));
      const release = releaseGroups[0] || {};
      const confidence = Math.min(1, Number(result.score || 0) * (difference <= 3 ? 1 : difference <= 10 ? .9 : difference <= 20 ? .7 : .45) * (release.release_group_id ? 1.01 : 1));
      if (!candidates.some(item => item.artist === artist && item.title === title)) candidates.push({ artist, title, album:release.album || '', year:release.year || null, release_group_id:release.release_group_id || null, duration_seconds: recording.duration ?? null, confidence, recording_id: recording.id });
    }
    candidates.sort((a,b) => b.confidence-a.confidence); const best = candidates[0];
    if (!best) await db.prepare("UPDATE recognition_jobs SET status='unmatched',candidates_json='[]',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    else if (best.confidence >= .8) await db.transaction(async tx => {
      await tx.prepare("UPDATE tracks SET title=?,artist=?,album=CASE WHEN album='' THEN ? ELSE album END,year=COALESCE(year,?) WHERE id=?").run(best.title,best.artist,best.album || '',best.year,job.track_id);
      await tx.prepare("UPDATE recognition_jobs SET status='applied',confidence=?,suggested_title=?,suggested_artist=?,candidates_json=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(best.confidence,best.title,best.artist,JSON.stringify(candidates.slice(0,5)),job.id);
    });
    else await db.prepare("UPDATE recognition_jobs SET status='review',confidence=?,suggested_title=?,suggested_artist=?,candidates_json=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(best.confidence, best.title, best.artist, JSON.stringify(candidates.slice(0,5)), job.id);
    if (best && best.confidence >= .8 && best.release_group_id) await addExternalCover(job.track_id,best.release_group_id).catch(error => console.error('Не удалось загрузить обложку:', error.message));
  } catch (error) {
    const message = String(error.message || error).slice(0,1000), attempts = Number(job?.attempts || 0);
    if (job) await db.prepare(`UPDATE recognition_jobs SET status=?,available_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(attempts >= 5 ? 'failed' : 'retry', Math.min(3600, 30 * (2 ** Math.max(0,attempts-1))), message, job.id).catch(()=>{});
    console.error('Ошибка распознавания:', message);
  } finally { recognitionBusy = false; }
}

async function recognitionSettings() {
  const rows = await db.prepare("SELECT key,value FROM app_settings WHERE key IN ('recognition_enabled','acoustid_client_key')").all();
  const values = Object.fromEntries(rows.map(row => [row.key,row.value]));
  return {
    enabled: values.recognition_enabled === undefined ? config.recognitionEnabled : values.recognition_enabled === 'true',
    clientKey: values.acoustid_client_key === undefined ? config.acoustIdClientKey : values.acoustid_client_key,
  };
}

async function registrationEnabled() {
  const row=await db.prepare("SELECT value FROM app_settings WHERE key='registration_enabled'").get();
  return row===undefined?config.registrationEnabled:row.value==='true';
}

let transcodeActive = 0;
async function processNextTranscode() {
  if (transcodeActive >= 2) return;
  transcodeActive++;
  let job;
  try {
    const result = await db.prepare(`UPDATE track_files SET status='processing',updated_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM track_files WHERE status IN ('queued','retry') ORDER BY priority DESC,updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`).run();
    job = result.rows[0]; if (!job) return;
    const track = await db.prepare('SELECT storage_key FROM tracks WHERE id=?').get(job.track_id);
    if (!track) return await db.prepare("UPDATE track_files SET status='failed',error='Трек удалён',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    const source = path.resolve(config.storageDir, track.storage_key), shard = job.track_id.slice(0, 2);
    const targetDir = path.join(derivedDir, job.variant, shard); fs.mkdirSync(targetDir, { recursive: true, mode: 0o750 });
    const storageKey = path.join('derived', job.variant, shard, `${job.track_id}.m4a`), target = path.join(config.storageDir, storageKey), temporary = `${target}.part`;
    const bitrate = job.variant === 'aac_96' ? '96k' : '192k';
    const ok = await runProcess('ffmpeg', ['-loglevel','error','-y','-i',source,'-map','0:a:0','-vn','-c:a','aac','-b:a',bitrate,'-movflags','+faststart','-f','mp4',temporary]);
    if (!ok || !fs.existsSync(temporary)) throw new Error('ffmpeg не создал AAC');
    fs.renameSync(temporary, target); const size = fs.statSync(target).size;
    await db.prepare("UPDATE track_files SET status='ready',mime_type='audio/mp4',codec='aac',bitrate=?,size_bytes=?,storage_key=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.variant === 'aac_96' ? 96000 : 192000, size, storageKey, job.id);
  } catch (error) {
    console.error('Ошибка транскодирования:', error);
    if (job) await db.prepare("UPDATE track_files SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(error.message || error).slice(0,1000), job.id).catch(() => {});
  }
  finally { transcodeActive--; }
}

function normalizedTags(format) {
  const source = format.tags ?? {};
  const tags = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  const number = value => { const parsed = Number.parseInt(String(value ?? '').split('/')[0], 10); return Number.isFinite(parsed) ? parsed : null; };
  return {
    title: tags.title || '', artist: tags.album_artist || tags.albumartist || tags.artist || '',
    album: tags.album || '', genre: tags.genre || '', year: number(tags.date || tags.year),
    trackNumber: number(tags.track || tags.tracknumber), discNumber: number(tags.disc || tags.discnumber),
  };
}

async function extractCover(file, trackId) {
  const shard = trackId.slice(0, 2);
  const destinationDir = path.join(coverDir, shard);
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o750 });
  const coverKey = path.join('covers', shard, `${trackId}.jpg`);
  const destination = path.join(config.storageDir, coverKey);
  const ok = await runProcess('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(1000,iw)':'min(1000,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', destination]);
  if (!ok) { fs.rmSync(destination, { force: true }); return null; }
  return coverKey;
}

async function addExternalCover(trackId, releaseGroupId) {
  const track = await db.prepare('SELECT cover_key FROM tracks WHERE id=?').get(trackId);
  if (!track || track.cover_key) return;
  const response = await fetch(`https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupId)}/front-500`, { headers:{ 'User-Agent':'FamilyMusic/1.0' }, signal:AbortSignal.timeout(30000) });
  if (!response.ok) return;
  const bytes = Buffer.from(await response.arrayBuffer()); if (!bytes.length || bytes.length > 12*1024*1024) return;
  const temporary = path.join(uploadDir, `cover-${crypto.randomUUID()}.image`); fs.writeFileSync(temporary,bytes,{ mode:0o640 });
  try { const coverKey = await extractCover(temporary,trackId); if (coverKey) await db.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=? AND cover_key IS NULL').run(coverKey,trackId); }
  finally { fs.rmSync(temporary,{ force:true }); }
}

async function finalizeUpload(upload) {
  const temporary = path.join(uploadDir, `${upload.id}.part`);
  const trackId = upload.candidate_track_id || crypto.randomUUID();
  const extension = path.extname(upload.filename).toLowerCase().slice(0, 12) || '.audio';
  const shard = trackId.slice(0, 2);
  const destinationDir = path.join(originalDir, shard);
  const storageKey = path.join('originals', shard, `${trackId}${extension}`);
  const destination = path.join(config.storageDir, storageKey);
  const source = fs.existsSync(temporary) ? temporary : destination;
  if (!fs.existsSync(source)) throw new Error('Временный файл загрузки не найден');
  const [metadata, sourceSha256] = await Promise.all([inspectAudio(source), sha256File(source)]);
  if (!metadata || !String(metadata.format_name ?? '').match(/mp3|flac|ogg|opus|aac|m4a|mp4|wav/)) {
    await db.prepare("UPDATE uploads SET status='failed', error='Файл не распознан как аудио', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(upload.id);
    fs.rmSync(source, { force: true });
    return;
  }
  const validation=await validateAudioDecode(source,metadata.duration);
  if(!validation.valid){
    await db.prepare("UPDATE uploads SET status='failed', error='Аудиофайл повреждён или обрезан', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(upload.id);
    fs.rmSync(source,{force:true});
    return;
  }
  const duplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sourceSha256);
  if (duplicate) {
    fs.rmSync(source, { force: true });
    await db.prepare("UPDATE uploads SET status='duplicate', track_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(duplicate.id, upload.id);
    return { duplicateId: duplicate.id };
  }
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o750 });
  const coverKey = await extractCover(source, trackId);
  const normalization = await normalizeHybridFlac(source);
  if (normalization.normalized) fs.renameSync(normalization.output, source);
  const sha256 = normalization.normalized ? await sha256File(source) : sourceSha256;
  if (normalization.normalized) {
    const normalizedDuplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sha256);
    if (normalizedDuplicate) {
      fs.rmSync(source, { force: true });
      if (coverKey) fs.rmSync(path.join(config.storageDir, coverKey), { force: true });
      await db.prepare("UPDATE uploads SET status='duplicate', track_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(normalizedDuplicate.id, upload.id);
      return { duplicateId: normalizedDuplicate.id };
    }
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
    if (recognition.enabled && recognition.clientKey && (!tags.title || !tags.artist)) await tx.prepare("INSERT INTO recognition_jobs(track_id,status) VALUES(?,'queued') ON CONFLICT(track_id) DO NOTHING").run(trackId);
    await tx.prepare("INSERT INTO loudness_jobs(track_id,status) VALUES(?,'queued') ON CONFLICT(track_id) DO NOTHING").run(trackId);
    if (requiresCompatibilityVariant(sourceCodec)) await tx.prepare("INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status,priority) VALUES(?,'aac_192','audio/mp4','aac',192000,'queued',50) ON CONFLICT(track_id,variant) DO NOTHING").run(trackId);
  });
  return { trackId };
}

async function enqueueUpload(uploadId, trackId) {
  await db.transaction(async tx => {
    await tx.prepare("UPDATE uploads SET status='processing',candidate_track_id=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(trackId, uploadId);
    await tx.prepare(`INSERT INTO processing_jobs(upload_id,status) VALUES(?,'queued')
      ON CONFLICT(upload_id) DO UPDATE SET status='queued',available_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP`).run(uploadId);
  });
}

async function claimProcessingJob() {
  return await db.transaction(async tx => {
    const result = await tx.prepare(`UPDATE processing_jobs SET status='processing',attempts=attempts+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM processing_jobs WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,upload_id,attempts`).run();
    return result.rows[0] ?? null;
  });
}

let workerBusy = false;
async function processNextJob() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const job = await claimProcessingJob();
    if (!job) return;
    const upload = await db.prepare('SELECT * FROM uploads WHERE id=?').get(job.upload_id);
    if (!upload || upload.status !== 'processing') {
      await db.prepare("UPDATE processing_jobs SET status='complete',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
      return;
    }
    try {
      await finalizeUpload(upload);
      await db.prepare("UPDATE processing_jobs SET status='complete',finished_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    } catch (error) {
      const message = String(error.message || error).slice(0, 1000);
      if (Number(job.attempts) >= 5) {
        await db.transaction(async tx => {
          await tx.prepare("UPDATE processing_jobs SET status='failed',finished_at=CURRENT_TIMESTAMP,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(message, job.id);
          await tx.prepare("UPDATE uploads SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(message, job.upload_id);
        });
      } else {
        const delaySeconds = Math.min(300, 5 * (2 ** (Number(job.attempts) - 1)));
        await db.prepare("UPDATE processing_jobs SET status='retry',available_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(delaySeconds, message, job.id);
      }
      console.error(`Ошибка обработки загрузки ${job.upload_id}:`, message);
    }
  } finally { workerBusy = false; }
}

async function recoverProcessingJobs() {
  await db.prepare("UPDATE processing_jobs SET status='retry',available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE status='processing'").run();
  await db.prepare(`INSERT INTO processing_jobs(upload_id,status)
    SELECT id,'queued' FROM uploads WHERE status='processing' ON CONFLICT(upload_id) DO NOTHING`).run();
}

let federationReplicaBusy = false;

function federationReplicaPaths(nodeId, objectId) {
  const shard = crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 16);
  return {
    temporaryPath: path.join(config.storageDir, 'federation', 'replicas', shard, `.${objectId}.part`),
  };
}

const federationSourceId = (nodeId,objectId) => `${nodeId}\n${objectId}`;

async function downloadFederationCover(nodeId,objectId,trackId){
  const remote=await db.prepare('SELECT cover_available FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(nodeId,objectId);
  if(!remote?.cover_available)return null;
  const peer=await db.prepare("SELECT * FROM federation_peers WHERE node_id=? AND revoked_at IS NULL AND status IN ('compatible','limited')").get(nodeId),identity=loadFederationIdentity(config.storageDir);
  if(!peer||!identity)return null;
  const remotePath=`/federation/v1/tracks/${encodeURIComponent(objectId)}/cover`,targetUri=`${peer.endpoint.replace(/\/$/,'')}${remotePath}`;
  const headers=signFederationRequest({method:'GET',targetUri,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem});
  const upstream=await openFederationStream(peer.endpoint,remotePath,headers,{timeoutMs:15000}),status=upstream.response.statusCode||502;
  if(status!==200){upstream.response.resume();return null;}
  const declared=Number(upstream.response.headers['content-length']);
  if(Number.isFinite(declared)&&(declared<1||declared>12*1024*1024)){upstream.response.destroy();throw new Error('Некорректный размер федеративной обложки');}
  const temporary=path.join(uploadDir,`federation-cover-${crypto.randomUUID()}.image`);let received=0;
  try{
    const output=fs.createWriteStream(temporary,{flags:'wx',mode:0o640});
    try{for await(const chunk of upstream.response){received+=chunk.length;if(received>12*1024*1024)throw new Error('Федеративная обложка превышает 12 МиБ');if(!output.write(chunk))await new Promise(resolve=>output.once('drain',resolve));}await new Promise((resolve,reject)=>output.end(error=>error?reject(error):resolve()));}catch(error){output.destroy();throw error;}
    if(!received)return null;
    return await extractCover(temporary,trackId);
  }finally{fs.rmSync(temporary,{force:true});}
}

async function completeFederationImport(job, paths, mimeType, total, sha256) {
  const remote=await db.prepare('SELECT * FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(job.origin_node_id,job.object_id);
  const likers=await db.prepare('SELECT user_id FROM federation_remote_likes WHERE origin_node_id=? AND object_id=? ORDER BY created_at').all(job.origin_node_id,job.object_id);
  if(!remote||!likers.length){fs.rmSync(paths.temporaryPath,{force:true});await db.prepare("UPDATE federation_remote_replicas SET status='removed',received_bytes=0,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(job.origin_node_id,job.object_id);return;}
  const sourceId=federationSourceId(job.origin_node_id,job.object_id);
  const duplicate=await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sha256);
  if(duplicate){
    fs.rmSync(paths.temporaryPath,{force:true});
    const duplicateTrack=await db.prepare('SELECT cover_key FROM tracks WHERE id=?').get(duplicate.id);
    let importedCover=null;if(!duplicateTrack?.cover_key)try{importedCover=await downloadFederationCover(job.origin_node_id,job.object_id,duplicate.id);}catch(error){console.error(`Не удалось импортировать обложку ${job.object_id}:`,error.message||error);}
    await db.transaction(async tx=>{
      if(importedCover)await tx.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=? AND cover_key IS NULL').run(importedCover,duplicate.id);
      for(const liker of likers)await tx.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(liker.user_id,duplicate.id);
      await tx.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('federation',?,?) ON CONFLICT(source,source_id) DO UPDATE SET track_id=excluded.track_id").run(sourceId,duplicate.id);
      await tx.prepare('DELETE FROM federation_remote_likes WHERE origin_node_id=? AND object_id=?').run(job.origin_node_id,job.object_id);
      await tx.prepare("UPDATE federation_remote_replicas SET status='imported',local_track_id=?,storage_key=NULL,mime_type=?,size_bytes=?,received_bytes=?,sha256=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(duplicate.id,mimeType,total,total,sha256,job.origin_node_id,job.object_id);
    });
    return;
  }
  const trackId=crypto.randomUUID(),shard=trackId.slice(0,2),destinationDir=path.join(originalDir,shard),destination=path.join(destinationDir,trackId);
  fs.mkdirSync(destinationDir,{recursive:true,mode:0o750});
  let coverKey=await extractCover(paths.temporaryPath,trackId);
  if(!coverKey)try{coverKey=await downloadFederationCover(job.origin_node_id,job.object_id,trackId);}catch(error){console.error(`Не удалось импортировать обложку ${job.object_id}:`,error.message||error);}
  fs.renameSync(paths.temporaryPath,destination);
  try{
    await db.transaction(async tx=>{
      await tx.prepare(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key,sha256,cover_key,cover_checked,genre,year,track_number,disc_number)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(trackId,likers[0].user_id,remote.title||'Без названия',remote.artist||'Неизвестный исполнитель',remote.album||'',`${remote.artist||'Исполнитель'} - ${remote.title||trackId}`,mimeType,total,remote.duration_seconds,path.posix.join('originals',shard,trackId),sha256,coverKey,remote.genre||'',remote.year,remote.track_number,remote.disc_number);
      for(const liker of likers)await tx.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(liker.user_id,trackId);
      await tx.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('federation',?,?)").run(sourceId,trackId);
      await tx.prepare('DELETE FROM federation_remote_likes WHERE origin_node_id=? AND object_id=?').run(job.origin_node_id,job.object_id);
      await tx.prepare("UPDATE federation_remote_replicas SET status='imported',local_track_id=?,storage_key=NULL,mime_type=?,size_bytes=?,received_bytes=?,sha256=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(trackId,mimeType,total,total,sha256,job.origin_node_id,job.object_id);
    });
  }catch(error){fs.renameSync(destination,paths.temporaryPath);if(coverKey)fs.rmSync(path.join(config.storageDir,coverKey),{force:true});throw error;}
}

async function claimFederationReplica() {
  return db.transaction(async tx => {
    const result = await tx.prepare(`UPDATE federation_remote_replicas SET status='downloading',attempts=attempts+1,error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE (origin_node_id,object_id)=(SELECT origin_node_id,object_id FROM federation_remote_replicas
        WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`).run();
    return result.rows[0] ?? null;
  });
}

async function processNextFederationReplica() {
  if (federationReplicaBusy) return;
  federationReplicaBusy = true;
  let job;
  try {
    job = await claimFederationReplica();
    if (!job) return;
    const peer = await db.prepare("SELECT * FROM federation_peers WHERE node_id=? AND revoked_at IS NULL AND status IN ('compatible','limited')").get(job.origin_node_id);
    const identity = loadFederationIdentity(config.storageDir);
    if (!peer || !identity) throw new Error('Исходная нода недоступна или доверие отозвано');

    const paths = federationReplicaPaths(job.origin_node_id, job.object_id);
    fs.mkdirSync(path.dirname(paths.temporaryPath), { recursive: true, mode: 0o750 });
    let offset = fs.existsSync(paths.temporaryPath) ? fs.statSync(paths.temporaryPath).size : 0;
    if(offset&&Number(job.size_bytes)===offset&&/^[0-9a-f]{64}$/.test(String(job.sha256||''))){
      const existingSha=await sha256File(paths.temporaryPath);
      if(existingSha===job.sha256){await completeFederationImport(job,paths,job.mime_type||'application/octet-stream',offset,existingSha);return;}
      fs.rmSync(paths.temporaryPath,{force:true});offset=0;
    }
    const query = new URLSearchParams({ quality: 'original' });
    if (offset) query.set('range', `bytes=${offset}-`);
    const remotePath = `/federation/v1/tracks/${encodeURIComponent(job.object_id)}/stream?${query}`;
    const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
    const headers = signFederationRequest({ method: 'GET', targetUri, nodeId: identity.node_id, privateKeyPem: identity.private_key_pem });
    const upstream = await openFederationStream(peer.endpoint, remotePath, headers, { timeoutMs: 30000 });
    const status = upstream.response.statusCode || 502;
    if (status !== 200 && status !== 206) {
      upstream.response.resume();
      throw new Error(`Исходная нода вернула HTTP ${status}`);
    }
    if (offset && status !== 206) {
      fs.rmSync(paths.temporaryPath, { force: true });
      offset = 0;
    }
    const range = String(upstream.response.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (status === 206 && (!range || Number(range[1]) !== offset)) {
      upstream.response.destroy();
      throw new Error('Исходная нода вернула неверный Content-Range');
    }
    const contentLength = Number(upstream.response.headers['content-length']);
    const total = range ? Number(range[3]) : contentLength;
    if (!Number.isSafeInteger(total) || total <= 0) {
      upstream.response.destroy();
      throw new Error('Исходная нода не сообщила корректный размер оригинала');
    }
    await db.prepare("UPDATE federation_remote_replicas SET size_bytes=?,received_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=? AND status='downloading'")
      .run(total,offset,job.origin_node_id,job.object_id);
    const output = fs.createWriteStream(paths.temporaryPath, { flags: offset ? 'a' : 'w', mode: 0o640 });
    let received = offset, reported = offset;
    try {
      for await (const chunk of upstream.response) {
        received += chunk.length;
        if (received > total) throw new Error('Получено больше заявленного размера оригинала');
        if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
        if (received - reported >= 1024 * 1024) {
          reported = received;
          await db.prepare("UPDATE federation_remote_replicas SET received_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=? AND status='downloading'")
            .run(received,job.origin_node_id,job.object_id);
        }
      }
      await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    } catch (error) {
      output.destroy();
      throw error;
    }
    if (received !== total) throw new Error(`Оригинал загружен не полностью: ${received} из ${total}`);
    const actualSha256 = await sha256File(paths.temporaryPath);
    const expectedSha256 = String(upstream.response.headers['x-music-sha256'] || '').toLowerCase();
    if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('Исходная нода вернула некорректный SHA-256');
    if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error('SHA-256 реплики не совпадает с оригиналом');
    const current = await db.prepare('SELECT status FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(job.origin_node_id,job.object_id);
    if (!current || current.status !== 'downloading') { fs.rmSync(paths.temporaryPath,{force:true}); return; }
    await completeFederationImport(job,paths,String(upstream.response.headers['content-type']||'application/octet-stream'),total,actualSha256);
  } catch (error) {
    if (job) {
      const paths = federationReplicaPaths(job.origin_node_id, job.object_id);
      const received = fs.existsSync(paths.temporaryPath) ? fs.statSync(paths.temporaryPath).size : 0;
      const delay = Math.min(3600, 10 * (2 ** Math.min(8, Math.max(0, Number(job.attempts) - 1))));
      await db.prepare("UPDATE federation_remote_replicas SET status='retry',received_bytes=?,available_at=CURRENT_TIMESTAMP+(? * INTERVAL '1 second'),error=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?")
        .run(received,delay,String(error.message||error).slice(0,1000),job.origin_node_id,job.object_id);
      console.error(`Ошибка репликации ${job.object_id}:`, error.message || error);
    }
  } finally { federationReplicaBusy = false; }
}

async function recoverFederationReplicas() {
  await db.prepare("UPDATE federation_remote_replicas SET status='retry',available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE status='downloading'").run();
  const ready=await db.prepare("SELECT * FROM federation_remote_replicas WHERE status='ready' AND storage_key IS NOT NULL").all();
  for(const replica of ready){const paths=federationReplicaPaths(replica.origin_node_id,replica.object_id),source=path.resolve(config.storageDir,replica.storage_key);fs.mkdirSync(path.dirname(paths.temporaryPath),{recursive:true,mode:0o750});if(source.startsWith(`${path.resolve(config.storageDir)}${path.sep}`)&&fs.existsSync(source))fs.renameSync(source,paths.temporaryPath);await db.prepare("UPDATE federation_remote_replicas SET status='queued',storage_key=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(replica.origin_node_id,replica.object_id);}
  await db.prepare(`INSERT INTO federation_remote_replicas(origin_node_id,object_id,status)
    SELECT DISTINCT origin_node_id,object_id,'queued' FROM federation_remote_likes ON CONFLICT(origin_node_id,object_id) DO NOTHING`).run();
}

async function cleanupAbandonedUploads() {
  const result = await db.prepare(`DELETE FROM uploads WHERE status='uploading'
    AND updated_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 hour') RETURNING id`).run(config.abandonedUploadHours);
  for (const upload of result.rows) fs.rmSync(path.join(uploadDir, `${upload.id}.part`), { force: true });
  const active = new Set((await db.prepare("SELECT id FROM uploads WHERE status IN ('uploading','processing')").all()).map(row => `${row.id}.part`));
  const cutoff = Date.now() - config.abandonedUploadHours * 3600000;
  for (const name of fs.readdirSync(uploadDir)) {
    if (!name.endsWith('.part') || active.has(name)) continue;
    const file = path.join(uploadDir, name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
  await db.prepare("DELETE FROM processing_jobs WHERE status IN ('complete','failed') AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'").run();
  if (result.rows.length) console.log(`Удалено брошенных загрузок: ${result.rows.length}`);
}

async function cleanupDiagnosticReports() {
  const allDays = Math.max(1, Math.floor(config.diagnosticRetentionDays));
  const fixedDays = Math.max(1, Math.floor(config.diagnosticFixedRetentionDays));
  const result = await db.prepare(`DELETE FROM diagnostic_reports
    WHERE created_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
       OR (status='fixed' AND updated_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))`).run(allDays, fixedDays);
  if (result.changes) console.log(`Удалено старых диагностических отчётов: ${result.changes}`);
}

async function updateWorkerHeartbeat() {
  const details = JSON.stringify({ pid: process.pid, version: process.version });
  await db.prepare(`INSERT INTO service_heartbeats(service,started_at,last_seen_at,details_json)
    VALUES('worker',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?) ON CONFLICT(service) DO UPDATE
    SET last_seen_at=CURRENT_TIMESTAMP,details_json=excluded.details_json`).run(details);
}

async function adminMetrics() {
  const [heartbeat, uploads, transcodes, recognition, loudness, replicas, summary, federation] = await Promise.all([
    db.prepare(`SELECT started_at,last_seen_at,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_seen_at)) AS age_seconds
      FROM service_heartbeats WHERE service='worker'`).get(),
    db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds
      FROM processing_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
    db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds
      FROM track_files WHERE status IN ('queued','processing','failed') GROUP BY status`).all(),
    db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds
      FROM recognition_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
    db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds
      FROM loudness_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
    db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds
      FROM federation_remote_replicas WHERE status IN ('queued','retry','downloading','failed') GROUP BY status`).all(),
    db.prepare(`SELECT (SELECT count(*) FROM tracks) AS tracks,
      (SELECT count(*) FROM sessions WHERE expires_at>CURRENT_TIMESTAMP) AS active_sessions,
      (SELECT count(*) FROM diagnostic_reports WHERE status='new') AS new_reports,
      (SELECT count(*) FROM uploads WHERE status='failed' AND updated_at>CURRENT_TIMESTAMP-INTERVAL '24 hours') AS upload_errors_24h`).get(),
    db.prepare(`SELECT count(*) FILTER(WHERE revoked_at IS NULL AND status<>'revoked') peers_active,count(*) FILTER(WHERE revoked_at IS NOT NULL OR status='revoked') peers_revoked,
      count(*) FILTER(WHERE revoked_at IS NULL AND (sync_error IS NOT NULL OR last_synced_at IS NULL OR last_synced_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes')) peers_offline,
      (SELECT count(*) FROM federation_remote_tracks) remote_tracks,(SELECT count(*) FROM federation_remote_likes) remote_likes,
      (SELECT count(*) FROM federation_playlist_tracks) remote_playlist_tracks,
      COALESCE(max(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_synced_at))) FILTER(WHERE revoked_at IS NULL),0) oldest_sync_seconds,
      count(*) FILTER(WHERE sync_error IS NOT NULL) sync_errors,count(*) FILTER(WHERE notify_error IS NOT NULL) notify_errors FROM federation_peers`).get(),
  ]);
  const queue = rows => Object.fromEntries(rows.map(row => [row.status, { count: Number(row.count), oldest_seconds: Math.round(Number(row.oldest_seconds)) }]));
  const workerAge = heartbeat ? Math.round(Number(heartbeat.age_seconds)) : null;
  return {
    generated_at: new Date().toISOString(),
    status: workerAge !== null && workerAge <= 45 ? 'ok' : 'degraded',
    api: { uptime_seconds: Math.floor(process.uptime()), started_at: processStartedAt.toISOString(), requests: httpMetrics.requests, errors_5xx: httpMetrics.errors5xx, memory_rss_bytes: process.memoryUsage().rss },
    worker: { status: workerAge !== null && workerAge <= 45 ? 'ok' : 'stale', last_seen_at: heartbeat?.last_seen_at ?? null, age_seconds: workerAge },
    queues: { uploads: queue(uploads), transcodes: queue(transcodes), recognition: queue(recognition), loudness: queue(loudness), federation_replicas: queue(replicas) },
    summary: Object.fromEntries(Object.entries(summary).map(([key,value]) => [key, Number(value)])),
    federation: {...Object.fromEntries(Object.entries(federation).map(([key,value])=>[key,Number(value||0)])),incoming_streams:[...incomingFederationStreams.values()].reduce((sum,value)=>sum+value,0),outgoing_streams:[...outgoingFederationStreams.values()].reduce((sum,value)=>sum+value,0)},
  };
}

async function cleanupFederationData(){
  await db.prepare('DELETE FROM federation_nonces WHERE expires_at<CURRENT_TIMESTAMP').run();
  await db.prepare("DELETE FROM federation_invitations WHERE (expires_at<CURRENT_TIMESTAMP OR revoked_at IS NOT NULL) AND created_at<CURRENT_TIMESTAMP-INTERVAL '30 days'").run();
}

async function enrichExistingTracks() {
  const tracks = await db.prepare('SELECT * FROM tracks WHERE sha256 IS NULL OR cover_checked=0').all();
  for (const track of tracks) {
    const file = path.resolve(config.storageDir, track.storage_key);
    if (!file.startsWith(config.storageDir + path.sep) || !fs.existsSync(file)) continue;
    try {
      const [metadata, sha256] = await Promise.all([inspectAudio(file), sha256File(file)]);
      if (!metadata) continue;
      const tags = normalizedTags(metadata);
      let coverKey = track.cover_key;
      if (!coverKey) coverKey = await extractCover(file, track.id);
      const duplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=? AND id<>?').get(sha256, track.id);
      await db.prepare(`UPDATE tracks SET sha256=?, cover_key=?, cover_checked=1, genre=CASE WHEN genre='' THEN ? ELSE genre END,
        year=COALESCE(year,?), track_number=COALESCE(track_number,?), disc_number=COALESCE(disc_number,?) WHERE id=?`).run(
        duplicate ? null : sha256, coverKey, tags.genre, tags.year, tags.trackNumber, tags.discNumber, track.id
      );
    } catch (error) { console.error(`Не удалось дополнить трек ${track.id}:`, error.message); }
  }
  if (tracks.length) console.log(`Проверены метаданные существующих треков: ${tracks.length}`);
}

async function api(req, res, url, apiPrefix = '/api') {
  if (url.pathname === '/api/health') {
    try {
      await db.prepare('SELECT 1 AS ok').get();
      fs.accessSync(config.storageDir, fs.constants.R_OK | fs.constants.W_OK);
      return sendJson(res, 200, { status: 'ok', database: 'ok', storage: 'ok', role: workerMode ? 'worker' : 'api' });
    } catch { return sendJson(res, 503, { status: 'degraded' }); }
  }
  if (url.pathname === '/api/setup/status') {
    const [users, settings, heartbeat, registration] = await Promise.all([
      db.prepare('SELECT count(*) count FROM users').get(),
      db.prepare("SELECT value FROM app_settings WHERE key='library_name'").get(),
      db.prepare("SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_seen_at)) AS age_seconds FROM service_heartbeats WHERE service='worker'").get(),
      registrationEnabled(),
    ]);
    const workerAge = heartbeat ? Number(heartbeat.age_seconds) : null;
    return sendJson(res, 200, {
      needs_setup: Number(users.count) === 0,
      setup_version: 1,
      server_version: softwareVersion,
      library_name: settings?.value || 'Family Music',
      registration_enabled: registration,
      checks: { database: 'ok', storage: 'ok', worker: workerAge !== null && workerAge <= 45 ? 'ok' : 'starting' },
    });
  }
  if (url.pathname === '/api/metrics/zabbix' && req.method === 'GET') {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const expected = config.metricsToken;
    const valid = expected && supplied && supplied.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!valid) return sendJson(res, 401, { error: 'Недействительный токен метрик' });
    const metrics = await adminMetrics();
    return sendJson(res, 200, {
      status: metrics.status,
      worker: metrics.worker,
      queues: metrics.queues,
      summary: metrics.summary,
      federation: metrics.federation,
      api: {
        uptime_seconds: metrics.api.uptime_seconds,
        errors_5xx: metrics.api.errors_5xx,
        memory_rss_bytes: metrics.api.memory_rss_bytes,
      },
    });
  }
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    const result=await authentication.setup(await readJson(req));
    if(result.status==='invalid')return sendJson(res,400,{error:result.error});
    if(result.status==='configured')return sendJson(res,409,{error:'Первичная настройка уже выполнена'});
    return sendJson(res,201,{ok:true,library_name:result.libraryName});
  }
  if (url.pathname === '/api/register' && req.method === 'POST') {
    if (!requestOriginMatches(req)) return sendJson(res,403,{error:'Недоверенный источник запроса'});
    if (!await registrationEnabled()) return sendJson(res,404,{error:'Регистрация отключена'});
    if (Number((await db.prepare('SELECT count(*) count FROM users').get()).count)===0) return sendJson(res,409,{error:'Сначала выполните первоначальную настройку сервера'});
    const ip=requestIp(req);
    if(!registrationLimiter.take(ip))return sendJson(res,429,{error:'Слишком много регистраций. Повторите позже'},{'Retry-After':'3600'});
    const values=validateRegistration(await readJson(req));
    if(values.error)return sendJson(res,400,{error:values.error});
    try{
      const result=await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,0) RETURNING id').run(values.username,values.displayName,hashPassword(values.password));
      return sendJson(res,201,{id:Number(result.rows[0].id),username:values.username,display_name:values.displayName});
    }catch(error){if(error.code==='23505')return sendJson(res,409,{error:'Такой логин уже занят'});throw error;}
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await authentication.login({ username:body.username, password:body.password, deviceName:body.device_name, clientName:body.client_name, userAgent:req.headers['user-agent'], ip:requestIp(req) });
    if (result.status === 'blocked') return sendJson(res, 429, { error: 'Слишком много попыток. Повторите позже' }, { 'Retry-After': '900' });
    if (result.status === 'invalid') return sendJson(res, 401, { error: 'Неверное имя пользователя или пароль' });
    return sendJson(res, 200, result.user, { 'Set-Cookie': result.cookie });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    await authentication.logout(req.headers.cookie);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (url.pathname === '/api/me') return sendJson(res, 200, user);
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { items: await authentication.listSessions(user) });
  }
  if (url.pathname === '/api/sessions/others' && req.method === 'DELETE') {
    return sendJson(res, 200, { ok: true, revoked: await authentication.revokeOtherSessions(user) });
  }
  const sessionDelete = /^\/api\/sessions\/(\d+)$/.exec(url.pathname);
  if (sessionDelete && req.method === 'DELETE') {
    const targetId = sessionDelete[1];
    const result = await authentication.revokeSession(user,targetId);
    if (!result) return sendJson(res, 404, { error: 'Сессия не найдена' });
    return sendJson(res, 200, { ok: true, current:result.current }, result.current ? { 'Set-Cookie': clearSessionCookie() } : {});
  }
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const items = await db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at, id').all();
    return sendJson(res, 200, { items });
  }
  if (url.pathname === '/api/admin/registration-settings' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res,403,{error:'Доступно только администратору'});
    return sendJson(res,200,{enabled:await registrationEnabled()});
  }
  if (url.pathname === '/api/admin/registration-settings' && req.method === 'PUT') {
    if (!user.is_admin) return sendJson(res,403,{error:'Доступно только администратору'});
    const enabled=Boolean((await readJson(req)).enabled);
    await db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('registration_enabled',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled?'true':'false');
    return sendJson(res,200,{enabled});
  }
  if (url.pathname === '/api/users' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const body = await readJson(req);
    const username = String(body.username ?? '').trim();
    const displayName = String(body.display_name ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return sendJson(res, 400, { error: 'Логин: 3–32 символа, латиница, цифры, ., _ и -' });
    if (displayName.length > 80) return sendJson(res, 400, { error: 'Отображаемое имя слишком длинное' });
    if (password.length < 10) return sendJson(res, 400, { error: 'Пароль должен содержать не менее 10 символов' });
    if (await db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(username)) return sendJson(res, 409, { error: 'Такой логин уже занят' });
    const result = await db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0) RETURNING id')
      .run(username, displayName || username, hashPassword(password));
    return sendJson(res, 201, { id: Number(result.rows[0].id), username, display_name: displayName || username, is_admin: 0 });
  }
  if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const [library, people, activity, uploadJobs, transcodeJobs, variants, recentErrors, storedTracks, storedVariants] = await Promise.all([
      db.prepare(`SELECT count(*) AS tracks, count(DISTINCT artist) AS artists,
        count(DISTINCT NULLIF(album,'')) AS albums, count(*) FILTER (WHERE cover_key IS NOT NULL) AS with_cover,
        count(*) FILTER (WHERE sha256 IS NULL) AS without_hash, COALESCE(sum(size_bytes),0) AS original_bytes,
        COALESCE(sum(duration_seconds),0) AS duration_seconds FROM tracks`).get(),
      db.prepare(`SELECT count(*) AS users, count(*) FILTER (WHERE is_admin=1) AS admins,
        (SELECT count(*) FROM sessions WHERE expires_at>CURRENT_TIMESTAMP) AS active_sessions FROM users`).get(),
      db.prepare(`SELECT (SELECT count(*) FROM track_likes) AS likes, (SELECT count(*) FROM playlists) AS playlists,
        (SELECT COALESCE(sum(play_count),0) FROM play_history) AS plays`).get(),
      db.prepare('SELECT status, count(*) AS count FROM processing_jobs GROUP BY status').all(),
      db.prepare('SELECT status, count(*) AS count FROM track_files GROUP BY status').all(),
      db.prepare(`SELECT variant, status, count(*) AS files, COALESCE(sum(size_bytes),0) AS bytes
        FROM track_files GROUP BY variant,status ORDER BY variant,status`).all(),
      db.prepare(`SELECT kind, item, error, updated_at FROM (
        SELECT 'Загрузка' AS kind, uploads.filename AS item, COALESCE(processing_jobs.last_error,uploads.error) AS error,
          GREATEST(uploads.updated_at,processing_jobs.updated_at) AS updated_at
          FROM uploads LEFT JOIN processing_jobs ON processing_jobs.upload_id=uploads.id
          WHERE uploads.status='failed' OR processing_jobs.status='failed'
        UNION ALL
        SELECT 'AAC' AS kind, tracks.artist || ' — ' || tracks.title AS item, track_files.error,
          track_files.updated_at FROM track_files JOIN tracks ON tracks.id=track_files.track_id WHERE track_files.status='failed'
        ) errors ORDER BY updated_at DESC LIMIT 10`).all(),
      db.prepare('SELECT id, storage_key, cover_key FROM tracks').all(),
      db.prepare("SELECT track_id,variant,storage_key FROM track_files WHERE status='ready'").all(),
    ]);
    const directories = Object.fromEntries(['originals','covers','derived','uploads'].map(name => [name, storageStats(path.join(config.storageDir, name))]));
    const disk = fs.statfsSync(config.storageDir);
    const missingOriginals = storedTracks.filter(track => !storedFileExists(track.storage_key)).map(track => track.id);
    const missingCovers = storedTracks.filter(track => track.cover_key && !storedFileExists(track.cover_key)).map(track => track.id);
    const missingVariants = storedVariants.filter(item => !storedFileExists(item.storage_key)).map(item => ({ track_id: item.track_id, variant: item.variant }));
    const numeric = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value]));
    return sendJson(res, 200, {
      generated_at: new Date().toISOString(), library: numeric(library), users: numeric(people), activity: numeric(activity),
      queues: { uploads: Object.fromEntries(uploadJobs.map(item => [item.status, Number(item.count)])), transcodes: Object.fromEntries(transcodeJobs.map(item => [item.status, Number(item.count)])) },
      variants: variants.map(numeric), storage: directories,
      disk: { total_bytes: disk.blocks * disk.bsize, free_bytes: disk.bavail * disk.bsize },
      integrity: { missing_originals: missingOriginals, missing_covers: missingCovers, missing_variants: missingVariants }, recent_errors: recentErrors,
    });
  }
  if (url.pathname === '/api/admin/metrics' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    return sendJson(res, 200, await adminMetrics());
  }
  if (url.pathname === '/api/admin/recognition-settings' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const settings = await recognitionSettings();
    return sendJson(res, 200, { enabled:settings.enabled, key_configured:Boolean(settings.clientKey) });
  }
  if (url.pathname === '/api/admin/federation' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    const availableAlbums = await db.prepare(`SELECT album AS name,count(*) AS track_count,max(year) AS year,min(artist) AS artist
      FROM tracks WHERE album<>'' GROUP BY album ORDER BY album COLLATE "C" LIMIT 1000`).all();
    const collections = await db.prepare(`SELECT collection.id,collection.name,count(item.track_id) AS track_count
      FROM federation_export_collections collection LEFT JOIN federation_export_collection_tracks item ON item.collection_id=collection.id
      GROUP BY collection.id ORDER BY collection.name COLLATE "C"`).all();
    return sendJson(res, 200, { ...settings, available_albums: availableAlbums, collections:collections.map(item=>({...item,track_count:Number(item.track_count)})), initialized: Boolean(identity), node_id: identity?.node_id ?? null, fingerprint: identity?.fingerprint ?? null, created_at: identity?.created_at ?? null });
  }
  if (url.pathname === '/api/admin/federation' && req.method === 'PUT') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const body = await readJson(req), enabled = Boolean(body.enabled), initialize = Boolean(body.initialize), exportPolicy = ['all','albums','collections'].includes(body.export_policy) ? body.export_policy : 'none';
    const selectedAlbums = [...new Set((Array.isArray(body.selected_albums) ? body.selected_albums : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
    const selectedCollections = [...new Set((Array.isArray(body.selected_collections) ? body.selected_collections : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
    const existingCollections = selectedCollections.length ? (await db.prepare('SELECT id FROM federation_export_collections WHERE id=ANY(?::text[])').all(selectedCollections)).map(item=>item.id) : [];
    if (existingCollections.length !== selectedCollections.length) return sendJson(res,400,{error:'Выбрана несуществующая коллекция'});
    const previousSettings = await federationExportSettings();
    const selectedTrackIds = selectedCollections.length ? (await db.prepare('SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])').all(selectedCollections)).map(item=>item.track_id) : [];
    const nextSettings = { export_policy: exportPolicy, selected_albums: selectedAlbums, selected_collections: selectedCollections, selected_track_ids:selectedTrackIds };
    const endpoints = validateFederationEndpoints(body.endpoints ?? []);
    let identity = loadFederationIdentity(config.storageDir);
    if ((initialize || enabled) && !identity) identity = ensureFederationIdentity(config.storageDir);
    if (enabled && !identity) return sendJson(res, 409, { error: 'Сначала создайте identity ноды' });
    await db.transaction(async tx => {
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('federation_enabled',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled ? 'true' : 'false');
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('federation_endpoints',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(endpoints));
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('federation_export_policy',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(exportPolicy);
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('federation_export_albums',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(selectedAlbums));
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('federation_export_collections',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(JSON.stringify(selectedCollections));
      await appendFederationVisibilityEvents(tx, previousSettings, nextSettings);
    });
    return sendJson(res, 200, { enabled, endpoints, export_policy: exportPolicy, selected_albums: selectedAlbums, selected_collections: selectedCollections, initialized: Boolean(identity), node_id: identity?.node_id ?? null, fingerprint: identity?.fingerprint ?? null, created_at: identity?.created_at ?? null });
  }
  if (url.pathname === '/api/admin/federation/collections' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res,403,{error:'Доступно только администратору'});
    const items=await db.prepare(`SELECT collection.id,collection.name,collection.created_at,collection.updated_at,count(item.track_id) AS track_count
      FROM federation_export_collections collection LEFT JOIN federation_export_collection_tracks item ON item.collection_id=collection.id
      GROUP BY collection.id ORDER BY collection.name COLLATE "C"`).all();
    return sendJson(res,200,{items:items.map(item=>({...item,track_count:Number(item.track_count)}))});
  }
  if (url.pathname === '/api/admin/federation/collections' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res,403,{error:'Доступно только администратору'});
    const name=String((await readJson(req)).name||'').trim().slice(0,120);
    if(!name)return sendJson(res,400,{error:'Укажите название коллекции'});
    if(await db.prepare('SELECT 1 FROM federation_export_collections WHERE lower(name)=lower(?)').get(name))return sendJson(res,409,{error:'Коллекция с таким названием уже существует'});
    const id=crypto.randomUUID();await db.prepare('INSERT INTO federation_export_collections(id,name,created_by) VALUES(?,?,?)').run(id,name,user.id);
    return sendJson(res,201,{id,name,track_count:0});
  }
  const collectionMatch=/^\/api\/admin\/federation\/collections\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(collectionMatch&&req.method==='GET'){
    if(!user.is_admin)return sendJson(res,403,{error:'Доступно только администратору'});
    const collection=await db.prepare('SELECT id,name,created_at,updated_at FROM federation_export_collections WHERE id=?').get(collectionMatch[1]);
    if(!collection)return sendJson(res,404,{error:'Коллекция не найдена'});
    const tracks=await db.prepare(`SELECT tracks.id,tracks.title,tracks.artist,tracks.album,tracks.duration_seconds
      FROM federation_export_collection_tracks item JOIN tracks ON tracks.id=item.track_id WHERE item.collection_id=?
      ORDER BY tracks.artist COLLATE "C",tracks.album COLLATE "C",tracks.disc_number NULLS LAST,tracks.track_number NULLS LAST,tracks.title COLLATE "C"`).all(collection.id);
    return sendJson(res,200,{...collection,tracks});
  }
  if(collectionMatch&&req.method==='PUT'){
    if(!user.is_admin)return sendJson(res,403,{error:'Доступно только администратору'});
    const body=await readJson(req,1024*1024),name=String(body.name||'').trim().slice(0,120),trackIds=[...new Set((Array.isArray(body.track_ids)?body.track_ids:[]).map(String))].slice(0,10000);
    if(!name)return sendJson(res,400,{error:'Укажите название коллекции'});
    const collection=await db.prepare('SELECT id FROM federation_export_collections WHERE id=?').get(collectionMatch[1]);if(!collection)return sendJson(res,404,{error:'Коллекция не найдена'});
    if(await db.prepare('SELECT 1 FROM federation_export_collections WHERE lower(name)=lower(?) AND id<>?').get(name,collection.id))return sendJson(res,409,{error:'Коллекция с таким названием уже существует'});
    const validIds=trackIds.length?(await db.prepare('SELECT id FROM tracks WHERE id=ANY(?::text[])').all(trackIds)).map(item=>item.id):[];
    if(validIds.length!==trackIds.length)return sendJson(res,400,{error:'В коллекции указан несуществующий трек'});
    const oldIds=(await db.prepare('SELECT track_id FROM federation_export_collection_tracks WHERE collection_id=?').all(collection.id)).map(item=>item.track_id),changed=[...new Set([...oldIds,...validIds])];
    await db.transaction(async tx=>{await tx.prepare('UPDATE federation_export_collections SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,collection.id);await tx.prepare('DELETE FROM federation_export_collection_tracks WHERE collection_id=?').run(collection.id);for(const trackId of validIds)await tx.prepare('INSERT INTO federation_export_collection_tracks(collection_id,track_id) VALUES(?,?)').run(collection.id,trackId);await appendFederationTrackRefreshEvents(tx,changed);});
    return sendJson(res,200,{id:collection.id,name,track_count:validIds.length});
  }
  if(collectionMatch&&req.method==='DELETE'){
    if(!user.is_admin)return sendJson(res,403,{error:'Доступно только администратору'});
    const collection=await db.prepare('SELECT id FROM federation_export_collections WHERE id=?').get(collectionMatch[1]);if(!collection)return sendJson(res,404,{error:'Коллекция не найдена'});
    const oldIds=(await db.prepare('SELECT track_id FROM federation_export_collection_tracks WHERE collection_id=?').all(collection.id)).map(item=>item.track_id);
    await db.transaction(async tx=>{await tx.prepare('DELETE FROM federation_export_collections WHERE id=?').run(collection.id);const setting=await tx.prepare("SELECT value FROM app_settings WHERE key='federation_export_collections'").get();if(setting)await tx.prepare("UPDATE app_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='federation_export_collections'").run(JSON.stringify(parseSettingList(setting.value).filter(id=>id!==collection.id)));const rules=await tx.prepare('SELECT peer_node_id,selected_collections_json FROM federation_peer_export_rules').all();for(const rule of rules)await tx.prepare('UPDATE federation_peer_export_rules SET selected_collections_json=?,updated_at=CURRENT_TIMESTAMP WHERE peer_node_id=?').run(JSON.stringify(parseSettingList(rule.selected_collections_json).filter(id=>id!==collection.id)),rule.peer_node_id);await appendFederationTrackRefreshEvents(tx,oldIds);});
    return sendJson(res,200,{ok:true});
  }
  if (url.pathname === '/api/admin/federation/check-endpoint' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const body = await readJson(req), scope = body.scope === 'private' ? 'private' : 'public';
    try { return sendJson(res, 200, await probeFederationEndpoint(body.url, scope)); }
    catch (error) { return sendJson(res, 422, { error: error.message, code: error.code || 'endpoint_check_failed' }); }
  }
  if (url.pathname === '/api/admin/federation/invitations' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const items = await db.prepare(`SELECT id,endpoint,expires_at,used_at,revoked_at,created_at,
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'used' WHEN expires_at<=CURRENT_TIMESTAMP THEN 'expired' ELSE 'active' END AS status
      FROM federation_invitations ORDER BY created_at DESC LIMIT 50`).all();
    return sendJson(res, 200, { items });
  }
  if (url.pathname === '/api/admin/federation/invitations' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) return sendJson(res, 409, { error: 'Сначала создайте identity и включите федерацию' });
    const publicEndpoint = settings.endpoints.find(item => item.scope === 'public')?.url;
    if (!publicEndpoint) return sendJson(res, 409, { error: 'Сначала сохраните публичный endpoint' });
    const body = await readJson(req), minutes = Math.max(5, Math.min(60, Number(body.expires_minutes) || 15));
    const id = crypto.randomUUID(), secret = randomToken(), expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
    await db.prepare('INSERT INTO federation_invitations(id,secret_hash,endpoint,expires_at,created_by) VALUES(?,?,?,?,?)')
      .run(id, tokenHash(secret), publicEndpoint, expiresAt, user.id);
    const invitation = { version: 1, invitation_id: id, issuer_node_id: identity.node_id, endpoint: publicEndpoint, public_key: identity.public_key, secret, expires_at: expiresAt };
    return sendJson(res, 201, { invitation, code: `fm-invite-v1:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}` });
  }
  const invitationDelete = /^\/api\/admin\/federation\/invitations\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (invitationDelete && req.method === 'DELETE') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const result = await db.prepare('UPDATE federation_invitations SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL AND revoked_at IS NULL RETURNING id').run(invitationDelete[1]);
    if (!result.changes) return sendJson(res, 404, { error: 'Активное приглашение не найдено' });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/federation/peers' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const items = await db.prepare(`SELECT federation_peers.node_id,federation_peers.label,federation_peers.endpoint,federation_peers.status,federation_peers.protocol_major,federation_peers.protocol_minor,federation_peers.capabilities_json,federation_peers.created_at,federation_peers.updated_at,federation_peers.last_seen_at,federation_peers.revoked_at,
      federation_peers.catalog_cursor,federation_peers.last_synced_at,federation_peers.next_sync_at,federation_peers.sync_failures,federation_peers.sync_error,federation_peers.remote_latest_revision,federation_peers.last_notified_revision,federation_peers.notify_failures,federation_peers.notify_error,
      (SELECT count(*) FROM federation_remote_tracks WHERE origin_node_id=federation_peers.node_id) AS remote_tracks,
      rule.policy AS export_policy,rule.selected_albums_json,rule.selected_collections_json
      FROM federation_peers LEFT JOIN federation_peer_export_rules rule ON rule.peer_node_id=federation_peers.node_id ORDER BY federation_peers.created_at DESC`).all();
    return sendJson(res, 200, { items: items.map(item => ({ ...item, export_policy:item.export_policy||'inherit',selected_albums:parseSettingList(item.selected_albums_json),selected_collections:parseSettingList(item.selected_collections_json),selected_albums_json:undefined,selected_collections_json:undefined,capabilities: JSON.parse(item.capabilities_json || '{}'), capabilities_json: undefined })) });
  }
  const peerPolicyMatch=/^\/api\/admin\/federation\/peers\/(fm:[A-Za-z0-9_-]{16,128})\/export-policy$/.exec(url.pathname);
  if(peerPolicyMatch&&req.method==='PUT'){
    if(!user.is_admin)return sendJson(res,403,{error:'Доступно только администратору'});
    const peer=await db.prepare('SELECT node_id FROM federation_peers WHERE node_id=? AND revoked_at IS NULL').get(peerPolicyMatch[1]);if(!peer)return sendJson(res,404,{error:'Активная нода не найдена'});
    const body=await readJson(req),policy=['inherit','none','all','albums','collections'].includes(body.policy)?body.policy:'inherit',selectedAlbums=[...new Set((Array.isArray(body.selected_albums)?body.selected_albums:[]).map(value=>String(value).trim()).filter(Boolean))].slice(0,1000),selectedCollections=[...new Set((Array.isArray(body.selected_collections)?body.selected_collections:[]).map(String))].slice(0,1000);
    const existing=selectedCollections.length?(await db.prepare('SELECT id FROM federation_export_collections WHERE id=ANY(?::text[])').all(selectedCollections)).map(item=>item.id):[];if(existing.length!==selectedCollections.length)return sendJson(res,400,{error:'Выбрана несуществующая коллекция'});
    const previous=await federationExportSettings(peer.node_id),selectedTrackIds=selectedCollections.length?(await db.prepare('SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])').all(selectedCollections)).map(item=>item.track_id):[],global=await federationExportSettings(),next=policy==='inherit'?global:{...global,export_policy:policy,selected_albums:selectedAlbums,selected_collections:selectedCollections,selected_track_ids:selectedTrackIds};
    await db.transaction(async tx=>{await tx.prepare(`INSERT INTO federation_peer_export_rules(peer_node_id,policy,selected_albums_json,selected_collections_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(peer_node_id) DO UPDATE SET policy=excluded.policy,selected_albums_json=excluded.selected_albums_json,selected_collections_json=excluded.selected_collections_json,updated_at=CURRENT_TIMESTAMP`).run(peer.node_id,policy,JSON.stringify(selectedAlbums),JSON.stringify(selectedCollections));await appendFederationVisibilityEvents(tx,previous,next);});
    return sendJson(res,200,{ok:true,policy,selected_albums:selectedAlbums,selected_collections:selectedCollections});
  }
  if (url.pathname === '/api/admin/federation/accept' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    try {
    const settings = await federationSettings(), identity = loadFederationIdentity(config.storageDir);
    if (!settings.enabled || !identity) return sendJson(res, 409, { error: 'Сначала создайте identity и включите федерацию' });
    if (!settings.endpoints.some(item => item.scope === 'public')) return sendJson(res, 409, { error: 'Сначала сохраните публичный endpoint этой ноды' });
    const input = String((await readJson(req)).code || '').trim(), prefix = 'fm-invite-v1:';
    if (!input.startsWith(prefix) || input.length > 16384) return sendJson(res, 400, { error: 'Некорректный код приглашения' });
    let invitation;
    try { invitation = JSON.parse(Buffer.from(input.slice(prefix.length), 'base64url').toString('utf8')); } catch { return sendJson(res, 400, { error: 'Некорректный код приглашения' }); }
    if (invitation.version !== 1 || !invitation.invitation_id || !invitation.secret || Date.parse(invitation.expires_at) <= Date.now()) return sendJson(res, 400, { error: 'Приглашение повреждено или истекло' });
    const described = describePublicKeyValue(String(invitation.public_key || ''));
    if (described.nodeId !== invitation.issuer_node_id) return sendJson(res, 400, { error: 'node_id приглашения не соответствует ключу' });
    if (invitation.issuer_node_id === identity.node_id) return sendJson(res, 409, { error: 'Нельзя принять приглашение собственной ноды' });
    const probe = await probeFederationEndpoint(invitation.endpoint, 'public');
    if (probe.node_id !== invitation.issuer_node_id) return sendJson(res, 409, { error: 'Endpoint отвечает от имени другой ноды' });
    const challenge = randomToken(), node = publicNodeDescriptor(identity, { softwareVersion, endpoints: settings.endpoints });
    const payload = JSON.stringify({ invitation_id: invitation.invitation_id, secret: invitation.secret, challenge, node });
    const targetUri = `${String(invitation.endpoint).replace(/\/$/, '')}/federation/v1/pairing/accept`;
    const headers = signFederationRequest({ method: 'POST', targetUri, body: payload, nodeId: identity.node_id, privateKeyPem: identity.private_key_pem });
    const response = await postFederationJson(invitation.endpoint, '/federation/v1/pairing/accept', payload, headers);
    const issuer = response.node || {}, issuerDescription = describePublicKeyValue(String(issuer.public_key?.value || ''));
    if (issuer.node_id !== invitation.issuer_node_id || issuerDescription.nodeId !== invitation.issuer_node_id || issuer.public_key.value !== invitation.public_key) return sendJson(res, 409, { error: 'Ответ подписан неожиданной identity' });
    const confirmationValues = { invitationId: invitation.invitation_id, requesterNodeId: identity.node_id, issuerNodeId: issuer.node_id, challenge };
    if (!verifyPairingConfirmation(confirmationValues, String(response.confirmation || ''), issuer.public_key.value)) return sendJson(res, 409, { error: 'Не удалось проверить подтверждение pairing' });
    const negotiation = negotiateFederation(issuer, ['pairing.v1']);
    const remoteMinor = negotiation.minor ?? 0, status = negotiation.status;
    await db.prepare(`INSERT INTO federation_peers(node_id,label,public_key,endpoint,status,protocol_major,protocol_minor,capabilities_json,last_seen_at)
      VALUES(?,?,?,?,?,1,?,?,CURRENT_TIMESTAMP) ON CONFLICT(node_id) DO UPDATE SET public_key=excluded.public_key,endpoint=excluded.endpoint,status=excluded.status,protocol_minor=excluded.protocol_minor,capabilities_json=excluded.capabilities_json,updated_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,revoked_at=NULL`)
      .run(issuer.node_id, '', issuer.public_key.value, invitation.endpoint, status, Math.max(0, remoteMinor), JSON.stringify(issuer.capabilities || {}));
    return sendJson(res, 200, { ok: true, node_id: issuer.node_id, endpoint: invitation.endpoint, status });
    } catch (error) {
      return sendJson(res, 422, { error: error.message || 'Не удалось подключить ноду', code: error.code || 'pairing_failed' });
    }
  }
  const peerDelete = /^\/api\/admin\/federation\/peers\/(fm:[A-Za-z0-9_-]{16,128})$/.exec(url.pathname);
  if (peerDelete && req.method === 'DELETE') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const result = await db.prepare("UPDATE federation_peers SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE node_id=? AND revoked_at IS NULL RETURNING node_id").run(peerDelete[1]);
    if (!result.changes) return sendJson(res, 404, { error: 'Активная нода не найдена' });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/admin/recognition-settings' && req.method === 'PUT') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const body = await readJson(req), enabled=Boolean(body.enabled);
    const keyProvided=Object.hasOwn(body,'client_key'), clientKey=keyProvided?String(body.client_key||'').trim():null;
    if (keyProvided && clientKey && !/^[A-Za-z0-9_-]{6,128}$/.test(clientKey)) return sendJson(res,400,{ error:'Некорректный Client API key AcoustID' });
    await db.transaction(async tx => {
      await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('recognition_enabled',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled?'true':'false');
      if(keyProvided) await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('acoustid_client_key',?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(clientKey);
    });
    const saved=await recognitionSettings();
    return sendJson(res,200,{ enabled:saved.enabled,key_configured:Boolean(saved.clientKey) });
  }
  if (url.pathname === '/api/admin/loudness' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const [states, values] = await Promise.all([
      db.prepare('SELECT status,count(*) AS count FROM loudness_jobs GROUP BY status').all(),
      db.prepare(`SELECT count(*) AS analyzed,round(avg(integrated_lufs)::numeric,2) AS average_lufs,
        round(min(integrated_lufs)::numeric,2) AS quietest_lufs,round(max(integrated_lufs)::numeric,2) AS loudest_lufs
        FROM loudness_jobs WHERE status='ready'`).get(),
    ]);
    return sendJson(res, 200, { states:Object.fromEntries(states.map(item=>[item.status,Number(item.count)])), values:{ analyzed:Number(values.analyzed), average_lufs:values.average_lufs==null?null:Number(values.average_lufs), quietest_lufs:values.quietest_lufs==null?null:Number(values.quietest_lufs), loudest_lufs:values.loudest_lufs==null?null:Number(values.loudest_lufs) } });
  }
  if (url.pathname === '/api/admin/loudness/scan' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const result = await db.prepare(`INSERT INTO loudness_jobs(track_id,status) SELECT id,'queued' FROM tracks ON CONFLICT(track_id) DO NOTHING`).run();
    pumpLoudness();
    return sendJson(res, 200, { queued:result.changes });
  }
  if (url.pathname === '/api/reports' && req.method === 'POST') {
    const body = await readJson(req, 48 * 1024);
    const description = String(body.description ?? '').trim().slice(0, 2000);
    if (!description) return sendJson(res, 400, { error: 'Опишите, что произошло' });
    const appVersion = String(body.app_version ?? '').slice(0, 40);
    const device = String(body.device ?? '').slice(0, 160);
    const androidVersion = String(body.android_version ?? '').slice(0, 80);
    const allowed = ['track','player','queue','network','storage','events'];
    const details = Object.fromEntries(allowed.filter(key => body.details?.[key] !== undefined).map(key => [key, body.details[key]]));
    let detailsJson = JSON.stringify(details);
    if (detailsJson.length > 40000) return sendJson(res, 413, { error: 'Диагностический журнал слишком большой' });
    const result = await db.prepare(`INSERT INTO diagnostic_reports(user_id,description,app_version,device,android_version,details_json)
      VALUES(?,?,?,?,?,?) RETURNING id,created_at`).run(user.id, description, appVersion, device, androidVersion, detailsJson);
    return sendJson(res, 201, { id: Number(result.rows[0].id), created_at: result.rows[0].created_at });
  }
  if (url.pathname === '/api/admin/reports' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const rows = await db.prepare(`SELECT diagnostic_reports.id,diagnostic_reports.description,diagnostic_reports.app_version,
      diagnostic_reports.device,diagnostic_reports.android_version,diagnostic_reports.details_json,diagnostic_reports.status,diagnostic_reports.created_at,diagnostic_reports.updated_at,
      users.username,users.display_name FROM diagnostic_reports JOIN users ON users.id=diagnostic_reports.user_id
      ORDER BY diagnostic_reports.created_at DESC LIMIT 100`).all();
    return sendJson(res, 200, { items: rows.map(row => ({ ...row, details: JSON.parse(row.details_json || '{}'), details_json: undefined })) });
  }
  const reportMatch = /^\/api\/admin\/reports\/(\d+)$/.exec(url.pathname);
  if (reportMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const reportId = Number(reportMatch[1]);
    if (req.method === 'DELETE') {
      const result = await db.prepare('DELETE FROM diagnostic_reports WHERE id=?').run(reportId);
      return result.changes ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Отчёт не найден' });
    }
    const status = String((await readJson(req)).status || '');
    if (!['new','viewed','fixed'].includes(status)) return sendJson(res, 400, { error: 'Некорректный статус' });
    const result = await db.prepare('UPDATE diagnostic_reports SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, reportId);
    return result.changes ? sendJson(res, 200, { ok: true, status }) : sendJson(res, 404, { error: 'Отчёт не найден' });
  }
  if (url.pathname === '/api/recognition' && req.method === 'GET') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const [items,states] = await Promise.all([db.prepare(`SELECT recognition_jobs.id,recognition_jobs.status,recognition_jobs.confidence,
      recognition_jobs.suggested_title,recognition_jobs.suggested_artist,recognition_jobs.candidates_json,
      recognition_jobs.error,recognition_jobs.updated_at,tracks.id AS track_id,tracks.title,tracks.artist,tracks.filename,
      tracks.duration_seconds,tracks.album,tracks.genre,tracks.year,tracks.cover_key FROM recognition_jobs JOIN tracks ON tracks.id=recognition_jobs.track_id
      WHERE recognition_jobs.status<>'applied' OR tracks.cover_key IS NULL ORDER BY recognition_jobs.updated_at DESC`).all(),
      db.prepare('SELECT status,count(*) AS count FROM recognition_jobs GROUP BY status').all()]);
    const settings = await recognitionSettings();
    return sendJson(res, 200, { enabled: settings.enabled && Boolean(settings.clientKey), states:Object.fromEntries(states.map(item=>[item.status,Number(item.count)])), items: items.map(item => ({
      ...item, confidence: item.confidence == null ? null : Number(item.confidence), duration_seconds: Number(item.duration_seconds || 0),
      candidates: JSON.parse(item.candidates_json || '[]'), cover_url:item.cover_key ? `${apiPrefix}/tracks/${item.track_id}/cover` : null, candidates_json: undefined, cover_key:undefined,
    })) });
  }
  if (url.pathname === '/api/recognition/scan' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const result = await db.prepare(`INSERT INTO recognition_jobs(track_id,status)
      SELECT id,'queued' FROM tracks WHERE artist='Неизвестный исполнитель'
      ON CONFLICT(track_id) DO NOTHING`).run();
    processNextRecognition().catch(error => console.error('Ошибка запуска распознавания:', error));
    return sendJson(res, 200, { queued: result.changes });
  }
  if (url.pathname === '/api/recognition/retry-all' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const result = await db.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE status IN ('ignored','unmatched','failed')").run();
    processNextRecognition().catch(()=>{}); return sendJson(res, 200, { queued:result.changes });
  }
  if (url.pathname === '/api/recognition/bulk' && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const body=await readJson(req),ids=Array.isArray(body.ids)?[...new Set(body.ids.map(Number).filter(Number.isSafeInteger))].slice(0,500):[],action=String(body.action||'');
    if(!ids.length)return sendJson(res,400,{error:'Не выбраны задания'});
    if(!['apply','retry','ignore','metadata'].includes(action))return sendJson(res,400,{error:'Некорректное массовое действие'});
    const jobs=await db.prepare('SELECT * FROM recognition_jobs WHERE id = ANY(@ids)').all({ids});let updated=0;const covers=[];
    if(action==='metadata'){
      const fields=body.fields&&typeof body.fields==='object'?body.fields:{},has=key=>Object.hasOwn(fields,key)&&String(fields[key]).trim()!=='';
      if(!['artist','album','genre','year'].some(has))return sendJson(res,400,{error:'Заполните хотя бы одно поле'});
      const artist=has('artist')?String(fields.artist).trim().slice(0,240):null,album=has('album')?String(fields.album).trim().slice(0,240):null,genre=has('genre')?String(fields.genre).trim().slice(0,120):null,year=has('year')?Number(fields.year):null;
      if(year!==null&&(!Number.isInteger(year)||year<1000||year>9999))return sendJson(res,400,{error:'Некорректный год'});
      await db.transaction(async tx=>{for(const job of jobs){await tx.prepare('UPDATE tracks SET artist=COALESCE(?,artist),album=COALESCE(?,album),genre=COALESCE(?,genre),year=COALESCE(?,year) WHERE id=?').run(artist,album,genre,year,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;}});
    } else await db.transaction(async tx=>{for(const job of jobs){
      if(action==='retry'){await tx.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;}
      else if(action==='ignore'){await tx.prepare("UPDATE recognition_jobs SET status='ignored',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);updated++;}
      else {const selected=JSON.parse(job.candidates_json||'[]')[0];if(job.status!=='review'||!selected)continue;await tx.prepare("UPDATE tracks SET title=?,artist=?,album=CASE WHEN album='' THEN ? ELSE album END,year=COALESCE(year,?) WHERE id=?").run(selected.title,selected.artist,selected.album||'',selected.year||null,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);if(selected.release_group_id)covers.push([job.track_id,selected.release_group_id]);updated++;}
    }});
    if(covers.length)Promise.allSettled(covers.map(([trackId,releaseGroupId])=>addExternalCover(trackId,releaseGroupId))).catch(()=>{});
    if(action==='retry')processNextRecognition().catch(()=>{});
    return sendJson(res,200,{updated,skipped:ids.length-updated});
  }
  const recognitionMatch = /^\/api\/recognition\/(\d+)\/(apply|ignore|retry|manual)$/.exec(url.pathname);
  if (recognitionMatch && req.method === 'POST') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const job = await db.prepare('SELECT * FROM recognition_jobs WHERE id=?').get(Number(recognitionMatch[1]));
    if (!job) return sendJson(res, 404, { error: 'Задание не найдено' });
    const action = recognitionMatch[2];
    if (action === 'ignore') { await db.prepare("UPDATE recognition_jobs SET status='ignored',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id); return sendJson(res, 200, { ok:true }); }
    if (action === 'retry') { await db.prepare("UPDATE recognition_jobs SET status='queued',attempts=0,error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id); processNextRecognition().catch(()=>{}); return sendJson(res, 200, { ok:true }); }
    if (action === 'manual') {
      const body = await readJson(req), title=String(body.title||'').trim(), artist=String(body.artist||'').trim(), album=String(body.album||'').trim(), genre=String(body.genre||'').trim();
      const year = body.year === '' || body.year == null ? null : Number(body.year);
      if (!title || !artist || title.length>240 || artist.length>240 || album.length>240 || genre.length>120) return sendJson(res,400,{ error:'Проверьте название и исполнителя' });
      if (year!==null && (!Number.isInteger(year) || year<1000 || year>9999)) return sendJson(res,400,{ error:'Некорректный год' });
      await db.transaction(async tx=>{await tx.prepare('UPDATE tracks SET title=?,artist=?,album=?,genre=?,year=? WHERE id=?').run(title,artist,album,genre,year,job.track_id);await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);});
      return sendJson(res,200,{ok:true});
    }
    if (job.status !== 'review') return sendJson(res, 409, { error: 'Готового варианта пока нет' });
    const body = await readJson(req), candidates = JSON.parse(job.candidates_json || '[]'), selected = candidates[Math.max(0,Math.min(candidates.length-1,Number(body.candidate)||0))];
    if (!selected) return sendJson(res, 409, { error: 'Вариант не найден' });
    await db.transaction(async tx => {
      await tx.prepare("UPDATE tracks SET title=?,artist=?,album=CASE WHEN album='' THEN ? ELSE album END,year=COALESCE(year,?) WHERE id=?").run(selected.title,selected.artist,selected.album || '',selected.year || null,job.track_id);
      await tx.prepare("UPDATE recognition_jobs SET status='applied',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
    });
    if (selected.release_group_id) await addExternalCover(job.track_id,selected.release_group_id).catch(()=>{});
    return sendJson(res, 200, { ok:true, track_id:job.track_id, title:selected.title, artist:selected.artist });
  }
  if (url.pathname === '/api/me/password' && req.method === 'PUT') {
    const body = await readJson(req);
    const result=await authentication.changeOwnPassword({userId:user.id,cookieHeader:req.headers.cookie,currentPassword:body.current_password,newPassword:body.new_password});
    if(result.status==='wrong_current')return sendJson(res,400,{error:'Текущий пароль указан неверно'});
    if(result.status==='invalid')return sendJson(res,400,{error:result.error});
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/federation/search' && req.method === 'GET') {
    const query=String(url.searchParams.get('q')||'').trim().slice(0,120),nodeId=String(url.searchParams.get('node_id')||''),queueRequest=url.searchParams.get('queue')==='1',limit=Math.min(queueRequest?10000:100,Math.max(1,Number(url.searchParams.get('limit'))||30)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    if(query.length<2&&!nodeId)return sendJson(res,200,{items:[],artists:[],albums:[],total:0,offset,limit,has_more:false});
    const params={query:`%${query}%`,node_id:nodeId,limit,offset,user_id:user.id};
    const filter=`${nodeId?'remote.origin_node_id=@node_id AND ':''}(remote.title ILIKE @query OR remote.artist ILIKE @query OR remote.album ILIKE @query OR remote.genre ILIKE @query)`;
    const total=Number((await db.prepare(`SELECT count(*) count FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' AND ${filter}`).get(params)).count);
    const rows=await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status,peer.last_synced_at,peer.sync_error,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) AS liked,
      (peer.sync_error IS NOT NULL OR peer.last_synced_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes') AS offline
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' AND ${filter}
      ORDER BY remote.artist COLLATE NOCASE,remote.album COLLATE NOCASE,remote.disc_number,remote.track_number,remote.title COLLATE NOCASE LIMIT @limit OFFSET @offset`).all(params);
    const items=rows.map(row=>{const remote_ref=encodeRemoteReference(row.origin_node_id,row.object_id);return {...row,id:`remote:${remote_ref}`,remote:true,remote_ref,stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remote_ref)}&quality=original`,source_label:row.label||row.endpoint,read_only:true,stream_available:!row.offline};});
    const artists=await db.prepare(`SELECT remote.origin_node_id,remote.artist AS name,peer.endpoint,peer.label,count(*) track_count FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${nodeId?'AND remote.origin_node_id=@node_id':''} AND remote.artist ILIKE @query GROUP BY remote.origin_node_id,remote.artist,peer.endpoint,peer.label ORDER BY track_count DESC LIMIT 100`).all(params);
    const albums=await db.prepare(`SELECT remote.origin_node_id,remote.album AS name,remote.artist,peer.endpoint,peer.label,count(*) track_count,max(remote.year) AS "year" FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${nodeId?'AND remote.origin_node_id=@node_id':''} AND remote.album<>'' AND (remote.album ILIKE @query OR remote.artist ILIKE @query) GROUP BY remote.origin_node_id,remote.album,remote.artist,peer.endpoint,peer.label ORDER BY track_count DESC LIMIT 100`).all(params);
    return sendJson(res,200,{items,artists,albums,total,offset,limit,has_more:offset+items.length<total});
  }
  if (url.pathname === '/api/federation/nodes' && req.method === 'GET') {
    const items=await db.prepare(`SELECT peer.node_id,peer.label,peer.endpoint,peer.status,peer.last_synced_at,peer.sync_error,count(remote.object_id) track_count
      FROM federation_peers peer LEFT JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id
      WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' GROUP BY peer.node_id ORDER BY peer.label,peer.endpoint`).all();
    return sendJson(res,200,{items});
  }
  if (url.pathname === '/api/favorites' && req.method === 'GET') {
    const query=String(url.searchParams.get('q')||'').trim().slice(0,120),queueRequest=url.searchParams.get('queue')==='1';
    const limit=Math.min(queueRequest?10000:200,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const sortSql={newest:'liked_at DESC',oldest:'liked_at ASC',title:'title COLLATE "C"',artist:'artist COLLATE "C",title COLLATE "C"',album:'album COLLATE "C",disc_number NULLS LAST,track_number NULLS LAST,title COLLATE "C"',year:'year DESC NULLS LAST,title COLLATE "C"'}[url.searchParams.get('sort')]||'liked_at DESC';
    const params={user_id:user.id,query:`%${query}%`,limit,offset};
    const filter=query?'AND (title ILIKE @query OR artist ILIKE @query OR album ILIKE @query OR genre ILIKE @query)':'';
    const total=Number((await db.prepare(`SELECT
      (SELECT count(*) FROM track_likes likes JOIN tracks ON tracks.id=likes.track_id WHERE likes.user_id=@user_id ${filter})+
      (SELECT count(*) FROM federation_remote_likes likes JOIN federation_remote_tracks remote ON remote.origin_node_id=likes.origin_node_id AND remote.object_id=likes.object_id WHERE likes.user_id=@user_id ${filter}) count`).get(params)).count);
    const rows=await db.prepare(`SELECT * FROM (
      SELECT 'local' kind,tracks.id,NULL::text origin_node_id,tracks.title,tracks.artist,tracks.album,tracks.filename,tracks.mime_type,
        tracks.size_bytes,tracks.duration_seconds,tracks.created_at,tracks.genre,tracks.year,tracks.track_number,tracks.disc_number,tracks.cover_key,
        likes.created_at liked_at,NULL::text endpoint,NULL::text label,NULL::text peer_status,NULL::timestamptz revoked_at,NULL::timestamptz last_synced_at,
        NULL::text sync_error,NULL::text replica_status,NULL::bigint replica_received_bytes,NULL::bigint replica_size_bytes,NULL::text replica_error
      FROM track_likes likes JOIN tracks ON tracks.id=likes.track_id WHERE likes.user_id=@user_id ${filter}
      UNION ALL
      SELECT 'remote' kind,remote.object_id,remote.origin_node_id,remote.title,remote.artist,remote.album,'' filename,'' mime_type,
        NULL::bigint size_bytes,remote.duration_seconds,remote.origin_created_at created_at,remote.genre,remote.year,remote.track_number,remote.disc_number,NULL::text cover_key,
        likes.created_at liked_at,peer.endpoint,peer.label,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,
        replica.status replica_status,replica.received_bytes replica_received_bytes,replica.size_bytes replica_size_bytes,replica.error replica_error
      FROM federation_remote_likes likes JOIN federation_remote_tracks remote ON remote.origin_node_id=likes.origin_node_id AND remote.object_id=likes.object_id
      JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id
      WHERE likes.user_id=@user_id ${filter}
    ) favorites ORDER BY ${sortSql},kind,origin_node_id NULLS FIRST,id LIMIT @limit OFFSET @offset`).all(params);
    const items=rows.map(row=>{
      if(row.kind==='local'){const {kind,cover_key,...track}=row;return{...track,liked:true,cover_url:cover_key?`${apiPrefix}/tracks/${row.id}/cover`:null};}
      const remote_ref=encodeRemoteReference(row.origin_node_id,row.id),availability=row.revoked_at||row.peer_status==='revoked'?'revoked':row.sync_error||!row.last_synced_at||new Date(row.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';
      return{...row,kind:undefined,id:`remote:${remote_ref}`,remote:true,remote_ref,liked:true,availability,stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remote_ref)}&quality=original`,cover_url:null,source_label:row.label||row.endpoint,stream_available:row.replica_status==='ready'||availability==='online'};
    });
    return sendJson(res,200,{items,total,limit,offset,has_more:offset+items.length<total});
  }
  if (url.pathname === '/api/library' && req.method === 'GET') {
    const query=String(url.searchParams.get('q')||'').trim().slice(0,120),scope=['local','remote'].includes(url.searchParams.get('scope'))?url.searchParams.get('scope'):'all',queueRequest=url.searchParams.get('queue')==='1';
    const limit=Math.min(queueRequest?10000:200,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const sortSql={newest:'created_at DESC NULLS LAST',oldest:'created_at ASC NULLS LAST',title:'title COLLATE "C"',artist:'artist COLLATE "C",title COLLATE "C"',album:'album COLLATE "C",disc_number NULLS LAST,track_number NULLS LAST,title COLLATE "C"',year:'year DESC NULLS LAST,title COLLATE "C"'}[url.searchParams.get('sort')]||'created_at DESC NULLS LAST';
    const params={user_id:user.id,query:`%${query}%`,limit,offset},filter=query?'AND (title ILIKE @query OR artist ILIKE @query OR album ILIKE @query OR genre ILIKE @query)':'';
    const localSql=scope==='remote'?'':`SELECT 'local' kind,tracks.id,NULL::text origin_node_id,tracks.title,tracks.artist,tracks.album,tracks.filename,tracks.mime_type,tracks.size_bytes,tracks.duration_seconds,tracks.created_at,tracks.genre,tracks.year,tracks.track_number,tracks.disc_number,tracks.cover_key,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.user_id=@user_id AND track_likes.track_id=tracks.id) liked,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') replay_gain_db,
      EXISTS(SELECT 1 FROM track_files WHERE track_files.track_id=tracks.id AND variant='aac_192' AND status='ready') aac_192_ready,
      EXISTS(SELECT 1 FROM track_files WHERE track_files.track_id=tracks.id AND variant='aac_96' AND status='ready') aac_96_ready,
      NULL::text endpoint,NULL::text label,NULL::text peer_status,NULL::timestamptz revoked_at,NULL::timestamptz last_synced_at,NULL::text sync_error
      FROM tracks WHERE TRUE ${filter}`;
    const importedFilter=scope==='all'?"AND NOT EXISTS(SELECT 1 FROM track_sources source WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\\n'||remote.object_id)":'';
    const remoteSql=scope==='local'?'':`SELECT 'remote' kind,remote.object_id id,remote.origin_node_id,remote.title,remote.artist,remote.album,'' filename,'' mime_type,NULL::bigint size_bytes,remote.duration_seconds,remote.origin_created_at created_at,remote.genre,remote.year,remote.track_number,remote.disc_number,NULL::text cover_key,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\\n'||remote.object_id AND local_like.user_id=@user_id)) liked,
      NULL::double precision replay_gain_db,FALSE aac_192_ready,FALSE aac_96_ready,peer.endpoint,peer.label,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${importedFilter} ${filter}`;
    const union=[localSql,remoteSql].filter(Boolean).join(' UNION ALL ');
    const total=Number((await db.prepare(`SELECT count(*) count FROM (${union}) library`).get(params)).count);
    const rows=await db.prepare(`SELECT * FROM (${union}) library ORDER BY ${sortSql},kind,origin_node_id NULLS FIRST,id LIMIT @limit OFFSET @offset`).all(params);
    const items=rows.map(row=>{
      if(row.kind==='local'){const {kind,cover_key,...track}=row;return{...track,cover_url:cover_key?`${apiPrefix}/tracks/${row.id}/cover`:null};}
      const remote_ref=encodeRemoteReference(row.origin_node_id,row.id),availability=row.revoked_at||row.peer_status==='revoked'?'revoked':row.sync_error||!row.last_synced_at||new Date(row.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';
      return{...row,kind:undefined,id:`remote:${remote_ref}`,remote:true,remote_ref,availability,stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remote_ref)}&quality=original`,cover_url:null,source_label:row.label||row.endpoint,stream_available:availability==='online'};
    });
    return sendJson(res,200,{items,total,limit,offset,has_more:offset+items.length<total,scope});
  }
  if (url.pathname === '/api/federation/liked' && req.method === 'GET') {
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const total=Number((await db.prepare('SELECT count(*) count FROM federation_remote_likes WHERE user_id=?').get(user.id)).count);
    const rows=await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,TRUE AS liked,
      replica.status AS replica_status,replica.received_bytes AS replica_received_bytes,replica.size_bytes AS replica_size_bytes,replica.error AS replica_error
      FROM federation_remote_likes likes JOIN federation_remote_tracks remote ON remote.origin_node_id=likes.origin_node_id AND remote.object_id=likes.object_id
      JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id
      WHERE likes.user_id=? ORDER BY likes.created_at DESC LIMIT ? OFFSET ?`).all(user.id,limit,offset);
    const items=rows.map(row=>{const remote_ref=encodeRemoteReference(row.origin_node_id,row.object_id),availability=row.revoked_at||row.peer_status==='revoked'?'revoked':row.sync_error||!row.last_synced_at||new Date(row.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';return {...row,id:`remote:${remote_ref}`,remote:true,remote_ref,availability,stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remote_ref)}&quality=original`,cover_url:null,source_label:row.label||row.endpoint,stream_available:row.replica_status==='ready'||availability==='online'};});
    return sendJson(res,200,{items,total,limit,offset,has_more:offset+items.length<total});
  }
  if (url.pathname === '/api/federation/track' && req.method === 'GET') {
    let decoded;try{decoded=decodeRemoteReference(url.searchParams.get('ref'));}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    const track=await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status,peer.last_synced_at,peer.sync_error,
      replica.status AS replica_status,replica.received_bytes AS replica_received_bytes,replica.size_bytes AS replica_size_bytes,replica.error AS replica_error,replica.local_track_id,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) AS liked
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id
      WHERE remote.origin_node_id=@node_id AND remote.object_id=@object_id`).get({user_id:user.id,node_id:decoded.nodeId,object_id:decoded.objectId});
    if(!track)return sendJson(res,404,{error:'Удалённый трек не найден'});
    const related=await db.prepare(`SELECT object_id,title,artist,album,year,duration_seconds FROM federation_remote_tracks WHERE origin_node_id=? AND object_id<>? AND (artist=? OR (album<>'' AND album=?)) ORDER BY album,disc_number,track_number,title LIMIT 20`).all(track.origin_node_id,track.object_id,track.artist,track.album);
    const remote_ref=encodeRemoteReference(track.origin_node_id,track.object_id);
    const availability=track.revoked_at||track.status==='revoked'?'revoked':track.sync_error||!track.last_synced_at||new Date(track.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';
    return sendJson(res,200,{...track,id:`remote:${remote_ref}`,remote:true,remote_ref,availability,stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remote_ref)}&quality=original`,source_label:track.label||track.endpoint,read_only:true,stream_available:track.replica_status==='ready'||availability==='online',related:related.map(item=>({...item,remote_ref:encodeRemoteReference(track.origin_node_id,item.object_id)}))});
  }
  if (url.pathname === '/api/federation/like' && ['PUT','DELETE'].includes(req.method)) {
    let decoded;try{decoded=decodeRemoteReference(url.searchParams.get('ref'));}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    if(!await db.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId,decoded.objectId))return sendJson(res,404,{error:'Удалённый трек не найден'});
    const imported=await db.prepare("SELECT tracks.id FROM track_sources JOIN tracks ON tracks.id=track_sources.track_id WHERE source='federation' AND source_id=?").get(federationSourceId(decoded.nodeId,decoded.objectId));
    if(imported){if(req.method==='PUT')await db.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(user.id,imported.id);else await db.prepare('DELETE FROM track_likes WHERE user_id=? AND track_id=?').run(user.id,imported.id);return sendJson(res,200,{ok:true,liked:req.method==='PUT',imported:true,local_track_id:imported.id});}
    if(req.method==='PUT')await db.transaction(async tx=>{
      await tx.prepare('INSERT INTO federation_remote_likes(user_id,origin_node_id,object_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(user.id,decoded.nodeId,decoded.objectId);
      await tx.prepare("INSERT INTO federation_remote_replicas(origin_node_id,object_id,status) VALUES(?,?,'queued') ON CONFLICT(origin_node_id,object_id) DO UPDATE SET status=CASE WHEN federation_remote_replicas.status='ready' THEN 'ready' ELSE 'queued' END,available_at=CURRENT_TIMESTAMP,error=CASE WHEN federation_remote_replicas.status='ready' THEN federation_remote_replicas.error ELSE NULL END,updated_at=CURRENT_TIMESTAMP").run(decoded.nodeId,decoded.objectId);
    });
    else await db.prepare('DELETE FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').run(user.id,decoded.nodeId,decoded.objectId);
    return sendJson(res,200,{ok:true,liked:req.method==='PUT'});
  }
  if (url.pathname === '/api/federation/replica' && ['GET','POST','DELETE'].includes(req.method)) {
    let decoded;try{decoded=decodeRemoteReference(url.searchParams.get('ref'));}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    const replica=await db.prepare('SELECT * FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId,decoded.objectId);
    if(req.method==='GET')return replica?sendJson(res,200,{status:replica.status,received_bytes:Number(replica.received_bytes||0),size_bytes:replica.size_bytes==null?null:Number(replica.size_bytes),local_track_id:replica.local_track_id||null,error:replica.error}):sendJson(res,404,{error:'Задания импорта нет'});
    if(req.method==='POST'){
      if(!await db.prepare('SELECT 1 FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').get(user.id,decoded.nodeId,decoded.objectId))return sendJson(res,403,{error:'Сначала добавьте трек в «Мне нравится»'});
      await db.prepare("INSERT INTO federation_remote_replicas(origin_node_id,object_id,status) VALUES(?,?,'queued') ON CONFLICT(origin_node_id,object_id) DO UPDATE SET status='queued',attempts=0,available_at=CURRENT_TIMESTAMP,error=NULL,updated_at=CURRENT_TIMESTAMP").run(decoded.nodeId,decoded.objectId);
      return sendJson(res,202,{ok:true,status:'queued'});
    }
    if(!replica)return sendJson(res,404,{error:'Локальной реплики нет'});
    if(replica.status==='imported')return sendJson(res,409,{error:'Импорт уже стал обычным локальным треком',local_track_id:replica.local_track_id});
    if(!user.is_admin&&!await db.prepare('SELECT 1 FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').get(user.id,decoded.nodeId,decoded.objectId))return sendJson(res,403,{error:'Удалять реплику может администратор или пользователь, добавивший трек в «Мне нравится»'});
    if(replica?.status==='downloading')return sendJson(res,409,{error:'Реплика сейчас загружается, повторите удаление позже'});
    if(replica?.storage_key){const file=path.resolve(config.storageDir,replica.storage_key);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true});}
    const paths=federationReplicaPaths(decoded.nodeId,decoded.objectId);fs.rmSync(paths.temporaryPath,{force:true});
    await db.prepare("UPDATE federation_remote_replicas SET status='removed',storage_key=NULL,mime_type=NULL,size_bytes=NULL,received_bytes=0,sha256=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(decoded.nodeId,decoded.objectId);
    return sendJson(res,200,{ok:true});
  }
  if (url.pathname === '/api/federation/prepare' && req.method === 'POST') {
    const body=await readJson(req),quality=['aac_96','aac_192'].includes(body.quality)?body.quality:'aac_192';let decoded;
    try{decoded=decodeRemoteReference(body.ref);}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    const peer=await db.prepare("SELECT peer.* FROM federation_peers peer JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id WHERE peer.node_id=? AND remote.object_id=? AND peer.revoked_at IS NULL AND peer.status<>'revoked'").get(decoded.nodeId,decoded.objectId);
    if(!peer)return sendJson(res,404,{error:'Удалённый трек не найден или доступ отозван'});
    try{
      const identity=loadFederationIdentity(config.storageDir),query=new URLSearchParams({quality,range:'bytes=0-0'}),remotePath=`/federation/v1/tracks/${encodeURIComponent(decoded.objectId)}/stream?${query}`,targetUri=`${peer.endpoint.replace(/\/$/,'')}${remotePath}`;
      const headers=signFederationRequest({method:'GET',targetUri,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem}),upstream=await openFederationStream(peer.endpoint,remotePath,headers),status=upstream.response.statusCode||502;
      upstream.response.resume();await new Promise(resolve=>{upstream.response.once('end',resolve);upstream.response.once('close',resolve);upstream.response.once('error',resolve);});
      if(status===200||status===206)return sendJson(res,200,{ready:true,quality});
      if(status===409)return sendJson(res,202,{ready:false,quality,retry_after_ms:500});
      return sendJson(res,502,{error:'Исходная нода не смогла подготовить аудио'});
    }catch(error){return sendJson(res,502,{error:error.message||'Удалённая нода недоступна'});}
  }
  if (url.pathname === '/api/federation/stream' && req.method === 'GET') {
    let decoded;try{decoded=decodeRemoteReference(url.searchParams.get('ref'));}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    const peer=await db.prepare("SELECT peer.* FROM federation_peers peer JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id WHERE peer.node_id=? AND remote.object_id=? AND peer.revoked_at IS NULL AND peer.status<>'revoked'").get(decoded.nodeId,decoded.objectId);
    if(!peer)return sendJson(res,404,{error:'Удалённый трек не найден или доступ отозван'});
    if(!acquireCounter(outgoingFederationStreams,peer.node_id,6))return sendJson(res,429,{error:'Слишком много одновременных удалённых потоков'});
    try{
      const identity=loadFederationIdentity(config.storageDir),quality=['original','aac_96','aac_192'].includes(url.searchParams.get('quality'))?url.searchParams.get('quality'):'original';
      const range=String(req.headers.range||'');if(range&&!/^bytes=(\d*)-(\d*)$/.test(range)){releaseCounter(outgoingFederationStreams,peer.node_id);res.writeHead(416);return res.end();}
      const query=new URLSearchParams({quality});if(range)query.set('range',range);const remotePath=`/federation/v1/tracks/${encodeURIComponent(decoded.objectId)}/stream?${query}`,targetUri=`${peer.endpoint.replace(/\/$/,'')}${remotePath}`;
      const headers=signFederationRequest({method:'GET',targetUri,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem}),upstream=await openFederationStream(peer.endpoint,remotePath,headers);
      const allowed=['content-type','content-length','content-range','accept-ranges','x-music-variant','cache-control'],responseHeaders=Object.fromEntries(allowed.filter(name=>upstream.response.headers[name]!=null).map(name=>[name,upstream.response.headers[name]]));res.writeHead(upstream.response.statusCode||502,responseHeaders);
      let released=false;const done=()=>{if(released)return;released=true;releaseCounter(outgoingFederationStreams,peer.node_id);};upstream.response.once('close',done);upstream.response.once('error',()=>res.destroy());req.once('aborted',()=>upstream.request.destroy());res.once('close',()=>{if(!res.writableEnded){upstream.request.destroy();upstream.response.destroy();}});upstream.response.pipe(res);return;
    }catch(error){releaseCounter(outgoingFederationStreams,peer.node_id);return sendJson(res,502,{error:error.message||'Удалённая нода недоступна'});}
  }
  const userPasswordMatch = /^\/api\/users\/(\d+)\/password$/.exec(url.pathname);
  if (userPasswordMatch && req.method === 'PUT') {
    if (!user.is_admin) return sendJson(res, 403, { error: 'Доступно только администратору' });
    const targetId = Number(userPasswordMatch[1]);
    if (targetId === user.id) return sendJson(res, 400, { error: 'Свой пароль меняется через профиль' });
    const result=await authentication.resetUserPassword({targetId,newPassword:(await readJson(req)).new_password});
    if(result.status==='not_found')return sendJson(res,404,{error:'Пользователь не найден'});
    if(result.status==='invalid')return sendJson(res,400,{error:result.error});
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/tracks' && req.method === 'GET') {
    return sendJson(res, 200, await catalog.listTracks({ searchParams: url.searchParams, userId: user.id }));
  }
  if (url.pathname === '/api/recommendations' && req.method === 'GET') {
    const tracks = (await db.prepare(`SELECT tracks.id,tracks.title,tracks.artist,tracks.album,tracks.filename,tracks.mime_type,
      tracks.size_bytes,tracks.duration_seconds,tracks.created_at,tracks.cover_key,tracks.genre,tracks.year,tracks.track_number,tracks.disc_number,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') AS replay_gain_db,
      EXISTS(SELECT 1 FROM track_files ready192 WHERE ready192.track_id=tracks.id AND ready192.variant='aac_192' AND ready192.status='ready') AS aac_192_ready,
      EXISTS(SELECT 1 FROM track_files ready96 WHERE ready96.track_id=tracks.id AND ready96.variant='aac_96' AND ready96.status='ready') AS aac_96_ready,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.track_id=tracks.id AND track_likes.user_id=@user_id) liked,
      COALESCE(play_history.play_count,0) play_count,play_history.last_played_at
      FROM tracks LEFT JOIN play_history ON play_history.track_id=tracks.id AND play_history.user_id=@user_id`).all({user_id:user.id})).map(track=>({
        ...track,liked:Boolean(track.liked),play_count:Number(track.play_count||0),cover_url:track.cover_key?`${apiPrefix}/tracks/${track.id}/cover`:null,cover_key:undefined,
      }));
    const day=new Date().toISOString().slice(0,10),randomScore=track=>parseInt(crypto.createHash('sha256').update(`${day}:${user.id}:${track.id}`).digest('hex').slice(0,12),16);
    const byNewest=(a,b)=>new Date(b.created_at)-new Date(a.created_at),byRecent=(a,b)=>new Date(b.last_played_at)-new Date(a.last_played_at);
    const played=tracks.filter(track=>track.last_played_at).sort(byRecent),liked=tracks.filter(track=>track.liked),affinity=new Map();
    for(const track of tracks){const weight=(track.liked?5:0)+Math.min(track.play_count,10);if(!weight)continue;if(track.artist&&track.artist!=='Неизвестный исполнитель')affinity.set(`artist:${track.artist}`, (affinity.get(`artist:${track.artist}`)||0)+weight);if(track.genre)affinity.set(`genre:${track.genre}`,(affinity.get(`genre:${track.genre}`)||0)+weight);}
    const recentCutoff=Date.now()-14*86400000;
    const discover=[...tracks].filter(track=>!track.last_played_at||new Date(track.last_played_at).getTime()<recentCutoff).map(track=>({track,score:(affinity.get(`artist:${track.artist}`)||0)*3+(affinity.get(`genre:${track.genre}`)||0)*2+randomScore(track)/1e14})).sort((a,b)=>b.score-a.score).map(item=>item.track).slice(0,20);
    const sections=[];
    if(played.length)sections.push({id:'continue',title:'Продолжить слушать',subtitle:'То, что звучало недавно',items:played.slice(0,12)});
    if(liked.length)sections.push({id:'favorites',title:'Любимые вперемешку',subtitle:'Ежедневный микс из ваших сердечек',items:[...liked].sort((a,b)=>randomScore(a)-randomScore(b)).slice(0,20)});
    if(discover.length)sections.push({id:'discover',title:'Давно не звучало',subtitle:'Знакомые исполнители и жанры без недавних повторов',items:discover});
    const newest=[...tracks].sort(byNewest).slice(0,16);if(newest.length)sections.push({id:'newest',title:'Недавно добавлено',subtitle:'Новое в общей семейной библиотеке',items:newest});
    const topGenres=[...affinity.entries()].filter(([key])=>key.startsWith('genre:')).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([key])=>key.slice(6));
    for(const genre of topGenres){const items=tracks.filter(track=>track.genre===genre).sort((a,b)=>randomScore(a)-randomScore(b)).slice(0,12);if(items.length>=2)sections.push({id:`genre-${genre}`,title:genre,subtitle:'Подборка по любимому жанру',items});}
    return sendJson(res,200,{generated_for:day,sections});
  }
  if (url.pathname === '/api/tracks/resolve' && req.method === 'POST') {
    const body = await readJson(req, 1024 * 1024);
    const requested=Array.isArray(body.ids)?[...new Set(body.ids.map(String))].slice(0,10000):[],ids=requested.filter(id=>/^[0-9a-f-]{36}$/.test(id)),remoteRefs=requested.filter(id=>id.startsWith('remote:')).map(id=>id.slice(7));
    if (!ids.length&&!remoteRefs.length) return sendJson(res, 200, { items: [] });
    const rows = ids.length ? await db.prepare(`SELECT id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,created_at,cover_key,genre,year,track_number,disc_number,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') AS replay_gain_db,
      EXISTS(SELECT 1 FROM track_files ready192 WHERE ready192.track_id=tracks.id AND ready192.variant='aac_192' AND ready192.status='ready') AS aac_192_ready,
      EXISTS(SELECT 1 FROM track_files ready96 WHERE ready96.track_id=tracks.id AND ready96.variant='aac_96' AND ready96.status='ready') AS aac_96_ready,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.track_id=tracks.id AND track_likes.user_id=@user_id) liked FROM tracks WHERE id = ANY(@ids)`).all({ user_id: user.id, ids }) : [];
    const byId = new Map(rows.map(track => [track.id, { ...track, cover_url: track.cover_key ? `${apiPrefix}/tracks/${track.id}/cover` : null, cover_key: undefined }]));
    for(const ref of remoteRefs)try{const decoded=decodeRemoteReference(ref),track=await db.prepare(`SELECT remote.*,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,replica.status replica_status,replica.received_bytes replica_received_bytes,replica.size_bytes replica_size_bytes,(EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) liked FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id WHERE remote.origin_node_id=@node_id AND remote.object_id=@object_id`).get({user_id:user.id,node_id:decoded.nodeId,object_id:decoded.objectId});if(track){const availability=track.revoked_at||track.peer_status==='revoked'?'revoked':track.sync_error||!track.last_synced_at||new Date(track.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';byId.set(`remote:${ref}`,{...track,id:`remote:${ref}`,remote:true,remote_ref:ref,availability,stream_available:track.replica_status==='ready'||availability==='online',stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(ref)}&quality=original`,cover_url:null});}}catch{}
    return sendJson(res, 200, { items: requested.map(id => byId.get(id)).filter(Boolean) });
  }
  if (url.pathname === '/api/catalog' && req.method === 'GET') {
    return sendJson(res, 200, await catalog.listCollections({ searchParams: url.searchParams }));
  }
  if (url.pathname === '/api/playlists' && req.method === 'GET') {
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    const total=Number((await db.prepare('SELECT count(*) count FROM playlists WHERE owner_id=?').get(user.id)).count);
    const items = await db.prepare(`SELECT playlists.id,playlists.title,playlists.description,playlists.created_at,count(playlist_tracks.track_id)+(SELECT count(*) FROM federation_playlist_tracks fpt WHERE fpt.playlist_id=playlists.id) track_count,COALESCE(sum(tracks.duration_seconds),0)+(SELECT COALESCE(sum(remote.duration_seconds),0) FROM federation_playlist_tracks fpt JOIN federation_remote_tracks remote ON remote.origin_node_id=fpt.origin_node_id AND remote.object_id=fpt.object_id WHERE fpt.playlist_id=playlists.id) duration_seconds,
      (SELECT track_id FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=playlists.id AND t.cover_key IS NOT NULL ORDER BY pt.position LIMIT 1) cover_track_id
      FROM playlists LEFT JOIN playlist_tracks ON playlist_tracks.playlist_id=playlists.id LEFT JOIN tracks ON tracks.id=playlist_tracks.track_id WHERE playlists.owner_id=?
      GROUP BY playlists.id ORDER BY playlists.updated_at DESC LIMIT ? OFFSET ?`).all(user.id,limit,offset);
    return sendJson(res, 200, { items,total,offset,limit,has_more:offset+items.length<total });
  }
  if (url.pathname === '/api/playlists' && req.method === 'POST') {
    const body = await readJson(req);
    const title = String(body.title ?? '').trim().slice(0,120);
    if (!title) return sendJson(res,400,{error:'Введите название плейлиста'});
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO playlists(id,owner_id,title,description) VALUES(?,?,?,?)').run(id,user.id,title,String(body.description??'').trim().slice(0,1000));
    return sendJson(res,201,{id,title});
  }
  const playlistMatch = /^\/api\/playlists\/([0-9a-f-]+)$/.exec(url.pathname);
  if (playlistMatch && req.method === 'PATCH') {
    const playlist=await db.prepare('SELECT * FROM playlists WHERE id=? AND owner_id=?').get(playlistMatch[1],user.id);
    if(!playlist)return sendJson(res,404,{error:'Плейлист не найден'});
    const body=await readJson(req);const title=String(body.title??'').trim().slice(0,120);
    if(!title)return sendJson(res,400,{error:'Введите название плейлиста'});
    await db.prepare('UPDATE playlists SET title=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title,String(body.description??'').trim().slice(0,1000),playlist.id);
    return sendJson(res,200,{ok:true});
  }
  if (playlistMatch && req.method === 'DELETE') {
    const result=await db.prepare('DELETE FROM playlists WHERE id=? AND owner_id=?').run(playlistMatch[1],user.id);
    return result.changes?sendJson(res,200,{ok:true}):sendJson(res,404,{error:'Плейлист не найден'});
  }
  const remotePlaylistMatch=/^\/api\/playlists\/([0-9a-f-]+)\/remote$/.exec(url.pathname);
  if(remotePlaylistMatch){
    const playlist=await db.prepare('SELECT * FROM playlists WHERE id=? AND owner_id=?').get(remotePlaylistMatch[1],user.id);if(!playlist)return sendJson(res,404,{error:'Плейлист не найден'});
    if(req.method==='GET'){
      const rows=await db.prepare(`SELECT remote.*,peer.label,peer.endpoint,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,replica.status replica_status,replica.received_bytes replica_received_bytes,replica.size_bytes replica_size_bytes,EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=? AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) liked
        FROM federation_playlist_tracks item JOIN federation_remote_tracks remote ON remote.origin_node_id=item.origin_node_id AND remote.object_id=item.object_id JOIN federation_peers peer ON peer.node_id=remote.origin_node_id LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id WHERE item.playlist_id=? ORDER BY item.position`).all(user.id,playlist.id);
      return sendJson(res,200,{items:rows.map(row=>{const ref=encodeRemoteReference(row.origin_node_id,row.object_id),availability=row.revoked_at||row.peer_status==='revoked'?'revoked':row.sync_error||!row.last_synced_at||new Date(row.last_synced_at)<new Date(Date.now()-10*60*1000)?'offline':'online';return{...row,id:`remote:${ref}`,remote:true,remote_ref:ref,availability,stream_available:row.replica_status==='ready'||availability==='online',stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(ref)}&quality=original`,cover_url:null,source_label:row.label||row.endpoint};})});
    }
    let decoded;try{decoded=decodeRemoteReference(url.searchParams.get('ref'));}catch{return sendJson(res,400,{error:'Некорректная ссылка на удалённый трек'});}
    if(req.method==='POST'){if(!await db.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId,decoded.objectId))return sendJson(res,404,{error:'Удалённый трек не найден'});const position=(await db.prepare('SELECT GREATEST(COALESCE((SELECT max(position) FROM playlist_tracks WHERE playlist_id=?),0),COALESCE((SELECT max(position) FROM federation_playlist_tracks WHERE playlist_id=?),0))+1 position').get(playlist.id,playlist.id)).position;await db.prepare('INSERT INTO federation_playlist_tracks(playlist_id,origin_node_id,object_id,position) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(playlist.id,decoded.nodeId,decoded.objectId,position);await db.prepare('UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(playlist.id);return sendJson(res,200,{ok:true});}
    if(req.method==='DELETE'){await db.prepare('DELETE FROM federation_playlist_tracks WHERE playlist_id=? AND origin_node_id=? AND object_id=?').run(playlist.id,decoded.nodeId,decoded.objectId);return sendJson(res,200,{ok:true});}
  }
  const playlistTracksMatch=/^\/api\/playlists\/([0-9a-f-]+)\/tracks(?:\/([0-9a-f-]+))?$/.exec(url.pathname);
  if(playlistTracksMatch){
    const playlist=await db.prepare('SELECT * FROM playlists WHERE id=? AND owner_id=?').get(playlistTracksMatch[1],user.id);
    if(!playlist)return sendJson(res,404,{error:'Плейлист не найден'});
    if(req.method==='POST'){
      const body=await readJson(req);const track=await db.prepare('SELECT id FROM tracks WHERE id=?').get(String(body.track_id??''));
      if(!track)return sendJson(res,404,{error:'Трек не найден'});
      const position=(await db.prepare('SELECT COALESCE(max(position),0)+1 position FROM playlist_tracks WHERE playlist_id=?').get(playlist.id)).position;
      await db.prepare('INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(playlist.id,track.id,position);
      await db.prepare('UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(playlist.id);
      return sendJson(res,200,{ok:true});
    }
    if(req.method==='DELETE'&&playlistTracksMatch[2]){
      await db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?').run(playlist.id,playlistTracksMatch[2]);
      await db.prepare('UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(playlist.id);
      return sendJson(res,200,{ok:true});
    }
  }
  if(url.pathname==='/api/history'&&req.method==='POST'){
    const body=await readJson(req);
    if(!await catalog.recordHistory({userId:user.id,trackId:String(body.track_id??'')}))return sendJson(res,404,{error:'Трек не найден'});
    return sendJson(res,200,{ok:true});
  }
  if(url.pathname==='/api/history'&&req.method==='GET'){
    return sendJson(res,200,await catalog.listHistory({searchParams:url.searchParams,userId:user.id,responsePrefix:apiPrefix}));
  }
  if(url.pathname==='/api/artists'&&req.method==='GET'){
    return sendJson(res,200,await catalog.lookupArtists({searchParams:url.searchParams}));
  }
  const artistMatch=/^\/api\/artists\/(\d+)$/.exec(url.pathname);
  if(artistMatch&&req.method==='GET'){
    const artist=await catalog.getArtist({artistId:Number(artistMatch[1]),responsePrefix:apiPrefix});
    if(!artist)return sendJson(res,404,{error:'Исполнитель не найден'});
    return sendJson(res,200,artist);
  }
  if(artistMatch&&req.method==='PATCH'){
    if(!user.is_admin)return sendJson(res,403,{error:'Только администратор может изменять карточку исполнителя'});
    const artist=await db.prepare('SELECT id FROM artists WHERE id=?').get(Number(artistMatch[1]));if(!artist)return sendJson(res,404,{error:'Исполнитель не найден'});
    const body=await readJson(req);await db.prepare('UPDATE artists SET bio=? WHERE id=?').run(String(body.bio||'').trim().slice(0,5000),artist.id);return sendJson(res,200,{ok:true});
  }
  const artistImageMatch=/^\/api\/artists\/(\d+)\/image$/.exec(url.pathname);
  if(artistImageMatch&&(req.method==='PUT'||req.method==='DELETE')){
    if(!user.is_admin)return sendJson(res,403,{error:'Только администратор может изменять изображение исполнителя'});
    const artist=await db.prepare('SELECT id,image_key FROM artists WHERE id=?').get(Number(artistImageMatch[1]));if(!artist)return sendJson(res,404,{error:'Исполнитель не найден'});
    if(req.method==='DELETE'){if(artist.image_key){const file=path.resolve(config.storageDir,artist.image_key);if(file.startsWith(config.storageDir+path.sep))fs.rmSync(file,{force:true});}await db.prepare('UPDATE artists SET image_key=NULL WHERE id=?').run(artist.id);return sendJson(res,200,{ok:true,image_url:null});}
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('image/'))return sendJson(res,415,{error:'Нужен файл изображения'});
    const source=path.join(uploadDir,`${crypto.randomUUID()}.artist-source`),target=path.join(artistDir,`${artist.id}.jpg`);
    try{fs.writeFileSync(source,await readBytes(req,12*1024*1024),{mode:0o640});const ok=await runProcess('ffmpeg',['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',"scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease",'-q:v','2',target]);if(!ok||!fs.existsSync(target))return sendJson(res,400,{error:'Не удалось прочитать изображение'});const key=path.join('artists',`${artist.id}.jpg`);await db.prepare('UPDATE artists SET image_key=? WHERE id=?').run(key,artist.id);return sendJson(res,200,{ok:true,image_url:`${apiPrefix}/artists/${artist.id}/image?v=${Date.now()}`});}finally{fs.rmSync(source,{force:true});}
  }
  const albumMatch=/^\/api\/albums\/(\d+)$/.exec(url.pathname);
  if(albumMatch&&(req.method==='GET'||req.method==='PATCH')){
    if(req.method==='GET'){
      const album=await catalog.getAlbum({albumId:Number(albumMatch[1]),userId:user.id,isAdmin:Boolean(user.is_admin),responsePrefix:apiPrefix});
      if(!album)return sendJson(res,404,{error:'Альбом не найден'});
      return sendJson(res,200,album);
    }
    const album=await db.prepare('SELECT id,name,artist,bio,image_key,year FROM albums WHERE id=?').get(Number(albumMatch[1]));
    if(!album)return sendJson(res,404,{error:'Альбом не найден'});
    if(!await canEditAlbum(user,album.id))return sendJson(res,403,{error:'Недостаточно прав для изменения альбома'});
    const body=await readJson(req),bio=String(body.bio??'').trim();
    if(bio.length>5000)return sendJson(res,400,{error:'Описание слишком длинное'});
    await db.prepare('UPDATE albums SET bio=? WHERE id=?').run(bio,album.id);album.bio=bio;
    return sendJson(res,200,{...album,image_url:album.image_key?`${apiPrefix}/albums/${album.id}/image`:null,image_key:undefined,can_edit:await canEditAlbum(user,album.id)});
  }
  const albumImageMatch=/^\/api\/albums\/(\d+)\/image$/.exec(url.pathname);
  if(albumImageMatch&&(req.method==='PUT'||req.method==='DELETE')){
    const album=await db.prepare('SELECT id,image_key FROM albums WHERE id=?').get(Number(albumImageMatch[1]));
    if(!album)return sendJson(res,404,{error:'Альбом не найден'});
    if(!await canEditAlbum(user,album.id))return sendJson(res,403,{error:'Недостаточно прав для изменения альбома'});
    if(req.method==='DELETE'){
      await db.prepare('UPDATE albums SET image_key=NULL WHERE id=?').run(album.id);
      if(album.image_key){const file=path.resolve(config.storageDir,album.image_key);if(file.startsWith(config.storageDir+path.sep))fs.rmSync(file,{force:true});}
      return sendJson(res,200,{ok:true,image_url:null});
    }
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('image/'))return sendJson(res,415,{error:'Нужен файл изображения'});
    const source=path.join(uploadDir,`${crypto.randomUUID()}.album-source`),temporary=path.join(uploadDir,`${crypto.randomUUID()}.album.jpg`),target=path.join(albumDir,`${album.id}.jpg`);
    try{
      fs.writeFileSync(source,await readBytes(req,12*1024*1024),{mode:0o640});
      const ok=await runProcess('ffmpeg',['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',"scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease",'-q:v','2',temporary]);
      if(!ok||!fs.existsSync(temporary))return sendJson(res,400,{error:'Не удалось прочитать изображение'});
      fs.renameSync(temporary,target);
      await db.prepare('UPDATE albums SET image_key=? WHERE id=?').run(path.join('albums',`${album.id}.jpg`),album.id);
      return sendJson(res,200,{ok:true,image_url:`${apiPrefix}/albums/${album.id}/image?v=${Date.now()}`});
    }finally{fs.rmSync(source,{force:true});fs.rmSync(temporary,{force:true});}
  }
  if(url.pathname==='/api/duplicates'&&req.method==='GET'){
    return sendJson(res,200,await catalog.listDuplicates({userId:user.id,isAdmin:Boolean(user.is_admin),responsePrefix:apiPrefix}));
  }
  if(url.pathname==='/api/playback-state'&&req.method==='GET'){
    const state=await db.prepare('SELECT track_id,remote_track_ref,position_seconds,queue_json,shuffle,repeat_mode,queue_source,updated_at FROM playback_state WHERE user_id=?').get(user.id);
    if(!state)return sendJson(res,200,{track_id:null,position_seconds:0,queue:[],shuffle:false,repeat_mode:'off',queue_source:'Очередь'});
    let queue=[];try{queue=JSON.parse(state.queue_json);}catch{}
    return sendJson(res,200,{...state,track_id:state.remote_track_ref?`remote:${state.remote_track_ref}`:state.track_id,remote_track_ref:undefined,queue,queue_json:undefined,shuffle:Boolean(state.shuffle)});
  }
  if(url.pathname==='/api/playback-state'&&req.method==='PUT'){
    const body=await readJson(req,1024*1024);
    const requestedTrackId=body.track_id?String(body.track_id):null,remoteTrackRef=requestedTrackId?.startsWith('remote:')?requestedTrackId.slice(7):null,trackId=remoteTrackRef?null:requestedTrackId;
    let decodedRemote=null;
    if(remoteTrackRef){try{decodedRemote=decodeRemoteReference(remoteTrackRef);}catch{return sendJson(res,400,{error:'Некорректный удалённый текущий трек'});}}
    const queue=Array.isArray(body.queue)?[...new Set(body.queue.map(String).filter(id=>/^[0-9a-f-]{36}$/.test(id)||id.startsWith('remote:')))].slice(0,10000):[];
    const repeatMode=['off','all','one'].includes(body.repeat_mode)?body.repeat_mode:'off';
    const queueSource=String(body.queue_source||'Очередь').trim().slice(0,120)||'Очередь';
    const position=Math.max(0,Number(body.position_seconds)||0);
    const saved=await savePlaybackState({db,userId:user.id,trackId,remoteTrackRef,decodedRemote,position,queue,shuffle:Boolean(body.shuffle),repeatMode,queueSource});
    if(!saved)return sendJson(res,400,{error:remoteTrackRef?'Некорректный удалённый текущий трек':'Некорректный текущий трек'});
    return sendJson(res,200,{ok:true});
  }
  if (url.pathname === '/api/tracks/batch' && req.method === 'POST') {
    const body=await readJson(req,1024*1024),items=Array.isArray(body.items)?body.items.slice(0,500):[];
    const ids=[...new Set(items.map(item=>String(item.id||'')).filter(id=>/^[0-9a-f-]{36}$/.test(id)))];
    if(ids.length<1)return sendJson(res,400,{error:'Выберите хотя бы один трек'});
    const tracks=await db.prepare('SELECT id,owner_id,artist,album_id FROM tracks WHERE id = ANY(@ids)').all({ids});
    if(tracks.length!==ids.length)return sendJson(res,404,{error:'Один из треков не найден'});
    if(!user.is_admin&&tracks.some(track=>track.owner_id!==user.id))return sendJson(res,403,{error:'Недостаточно прав для изменения одного из треков'});
    const clean=(value,max=240)=>String(value??'').trim().slice(0,max),artist=clean(body.artist),album=clean(body.album),genre=clean(body.genre,120);
    const year=body.year===''||body.year==null?null:Number(body.year);
    if(!album)return sendJson(res,400,{error:'Введите название альбома'});
    if(year!==null&&(!Number.isInteger(year)||year<1000||year>9999))return sendJson(res,400,{error:'Некорректный год'});
    const requestedAlbumId=Number(body.album_id)||0;
    if(requestedAlbumId&&(!Number.isSafeInteger(requestedAlbumId)||!tracks.some(track=>Number(track.album_id)===requestedAlbumId)))return sendJson(res,400,{error:'Альбом не соответствует выбранным трекам'});
    const existingAlbum=requestedAlbumId?await db.prepare('SELECT id,artist FROM albums WHERE id=?').get(requestedAlbumId):null;
    if(requestedAlbumId&&!existingAlbum)return sendJson(res,404,{error:'Альбом не найден'});
    const firstArtist=tracks.find(track=>track.id===ids[0])?.artist||'Неизвестный исполнитель';
    const albumArtist=artist||existingAlbum?.artist||firstArtist.replace(/\s+(feat(?:uring)?\.?|ft\.?).*$/i,'').split(',')[0].trim()||'Неизвестный исполнитель';
    const conflicting=await db.prepare('SELECT id FROM albums WHERE lower(name)=lower(?) AND lower(artist)=lower(?)').get(album,albumArtist);
    if(conflicting&&requestedAlbumId&&Number(conflicting.id)!==requestedAlbumId)return sendJson(res,409,{error:'Альбом с таким названием и исполнителем уже существует'});
    if(!user.is_admin&&(requestedAlbumId||conflicting)&&!await canEditAlbum(user,requestedAlbumId||conflicting.id))return sendJson(res,403,{error:'Недостаточно прав для изменения общего альбома'});
    let savedAlbumId;
    await db.transaction(async tx=>{
      if(requestedAlbumId){
        await tx.prepare('UPDATE albums SET name=?,artist=?,year=COALESCE(?,year) WHERE id=?').run(album,albumArtist,year,requestedAlbumId);
        await tx.prepare('UPDATE tracks SET album=? WHERE album_id=? AND album<>?').run(album,requestedAlbumId,album);
        savedAlbumId=requestedAlbumId;
      }else{
        const saved=await tx.prepare(`INSERT INTO albums(name,artist,year) VALUES(?,?,?) ON CONFLICT((lower(name)),(lower(artist))) DO UPDATE SET year=COALESCE(EXCLUDED.year,albums.year) RETURNING id`).get(album,albumArtist,year);
        savedAlbumId=Number(saved.id);
      }
      for(let index=0;index<items.length;index++){
        const item=items[index],id=String(item.id||'');if(!ids.includes(id))continue;
        const trackNumber=Number.isInteger(Number(item.track_number))&&Number(item.track_number)>0?Number(item.track_number):index+1;
        const discNumber=Number.isInteger(Number(item.disc_number))&&Number(item.disc_number)>0?Number(item.disc_number):1;
        await tx.prepare(`UPDATE tracks SET album=@album,album_id=@album_id,genre=CASE WHEN @genre='' THEN genre ELSE @genre END,year=COALESCE(@year,year),track_number=@track_number,disc_number=@disc_number WHERE id=@id`).run({album,album_id:savedAlbumId,genre,year,track_number:trackNumber,disc_number:discNumber,id});
      }
    });
    return sendJson(res,200,{ok:true,updated:ids.length,album_id:savedAlbumId});
  }
  if (url.pathname === '/api/tracks/batch-cover' && req.method === 'PUT') {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('image/')) return sendJson(res,415,{error:'Нужен файл изображения'});
    const ids=[...new Set(String(req.headers['x-track-ids']||'').split(',').map(id=>id.trim()).filter(id=>/^[0-9a-f-]{36}$/.test(id)))].slice(0,150);
    if(ids.length<2)return sendJson(res,400,{error:'Для общей обложки нужно минимум два трека'});
    const tracks=await db.prepare('SELECT id,owner_id,cover_key FROM tracks WHERE id = ANY(@ids)').all({ids});
    if(tracks.length!==ids.length)return sendJson(res,404,{error:'Один из треков не найден'});
    if(!user.is_admin&&tracks.some(track=>track.owner_id!==user.id))return sendJson(res,403,{error:'Недостаточно прав для изменения одного из треков'});
    const source=path.join(uploadDir,`${crypto.randomUUID()}.cover-source`),converted=path.join(uploadDir,`${crypto.randomUUID()}.cover.jpg`),temporary=[];
    try{
      fs.writeFileSync(source,await readBytes(req,12*1024*1024),{mode:0o640});
      const ok=await runProcess('ffmpeg',['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',"scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease",'-q:v','2',converted]);
      if(!ok||!fs.existsSync(converted))return sendJson(res,400,{error:'Не удалось прочитать изображение'});
      const updates=[];
      for(const track of tracks){
        const shard=track.id.slice(0,2),destinationDir=path.join(coverDir,shard),coverKey=path.join('covers',shard,`${track.id}.jpg`),target=path.join(config.storageDir,coverKey),temp=`${target}.${crypto.randomUUID()}.tmp`;
        fs.mkdirSync(destinationDir,{recursive:true,mode:0o750});fs.copyFileSync(converted,temp);temporary.push(temp);fs.renameSync(temp,target);updates.push({id:track.id,coverKey,previous:track.cover_key});
      }
      await db.transaction(async tx=>{for(const item of updates)await tx.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=?').run(item.coverKey,item.id);});
      for(const item of updates)if(item.previous&&item.previous!==item.coverKey){const previous=path.resolve(config.storageDir,item.previous);if(previous.startsWith(config.storageDir+path.sep))fs.rmSync(previous,{force:true});}
      return sendJson(res,200,{ok:true,updated:updates.length});
    }finally{fs.rmSync(source,{force:true});fs.rmSync(converted,{force:true});for(const file of temporary)fs.rmSync(file,{force:true});}
  }
  const trackArtistsMatch=/^\/api\/tracks\/([0-9a-f-]+)\/artists$/.exec(url.pathname);
  if(trackArtistsMatch&&req.method==='GET'){
    const track=await db.prepare('SELECT id FROM tracks WHERE id=?').get(trackArtistsMatch[1]);if(!track)return sendJson(res,404,{error:'Трек не найден'});
    const items=await db.prepare(`SELECT artists.id,artists.name,track_artists.role,track_artists.position FROM track_artists JOIN artists ON artists.id=track_artists.artist_id WHERE track_artists.track_id=? ORDER BY track_artists.position`).all(track.id);
    return sendJson(res,200,{items});
  }
  if(trackArtistsMatch&&req.method==='PUT'){
    const track=await db.prepare('SELECT id,owner_id FROM tracks WHERE id=?').get(trackArtistsMatch[1]);if(!track)return sendJson(res,404,{error:'Трек не найден'});if(track.owner_id!==user.id&&!user.is_admin)return sendJson(res,403,{error:'Недостаточно прав'});
    const body=await readJson(req),source=Array.isArray(body.items)?body.items.slice(0,20):[],seen=new Set(),credits=[];
    for(const item of source){const name=String(item?.name||'').trim().slice(0,240),role=item?.role==='featured'?'featured':'primary',key=name.toLocaleLowerCase();if(name&&!seen.has(key)){seen.add(key);credits.push({name,role});}}
    if(!credits.length||!credits.some(item=>item.role==='primary'))return sendJson(res,400,{error:'Добавьте хотя бы одного основного исполнителя'});
    const primary=credits.filter(item=>item.role==='primary').map(item=>item.name),featured=credits.filter(item=>item.role==='featured').map(item=>item.name),label=primary.join(', ')+(featured.length?` feat. ${featured.join(', ')}`:'');
    await db.transaction(async tx=>{await tx.prepare('UPDATE tracks SET artist=? WHERE id=?').run(label,track.id);for(const item of credits)await tx.prepare(`UPDATE track_artists SET role=? WHERE track_id=? AND artist_id=(SELECT id FROM artists WHERE lower(name)=lower(?) LIMIT 1)`).run(item.role,track.id,item.name);});
    const items=await db.prepare(`SELECT artists.id,artists.name,track_artists.role,track_artists.position FROM track_artists JOIN artists ON artists.id=track_artists.artist_id WHERE track_artists.track_id=? ORDER BY track_artists.position`).all(track.id);
    return sendJson(res,200,{artist:label,items});
  }
  const trackMatch = /^\/api\/tracks\/([0-9a-f-]+)$/.exec(url.pathname);
  if (trackMatch && req.method === 'PATCH') {
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(trackMatch[1]);
    if (!track) return sendJson(res, 404, { error: 'Трек не найден' });
    if (track.owner_id !== user.id && !user.is_admin) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const body = await readJson(req);
    const clean = value => String(value ?? '').trim().slice(0, 240);
    const title = clean(body.title);
    const artist = clean(body.artist);
    if (!title || !artist) return sendJson(res, 400, { error: 'Название и исполнитель обязательны' });
    const year = body.year === '' || body.year == null ? null : Number(body.year);
    if (year !== null && (!Number.isInteger(year) || year < 1000 || year > 9999)) return sendJson(res, 400, { error: 'Некорректный год' });
    await db.prepare('UPDATE tracks SET title=?,artist=?,album=?,genre=?,year=? WHERE id=?').run(title, artist, clean(body.album), clean(body.genre), year, track.id);
    return sendJson(res, 200, { ok: true });
  }
  if (trackMatch && req.method === 'DELETE') {
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(trackMatch[1]);
    if (!track) return sendJson(res, 404, { error: 'Трек не найден' });
    if (track.owner_id !== user.id && !user.is_admin) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const derived = await db.prepare("SELECT storage_key FROM track_files WHERE track_id=? AND storage_key IS NOT NULL").all(track.id);
    await db.prepare('DELETE FROM tracks WHERE id=?').run(track.id);
    for (const key of [track.storage_key, track.cover_key, ...derived.map(item => item.storage_key)]) {
      if (!key) continue;
      const file = path.resolve(config.storageDir, key);
      if (file.startsWith(config.storageDir + path.sep)) fs.rmSync(file, { force: true });
    }
    return sendJson(res, 200, { ok: true });
  }
  const trackCoverMatch = /^\/api\/tracks\/([0-9a-f-]+)\/cover$/.exec(url.pathname);
  if (trackCoverMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(trackCoverMatch[1]);
    if (!track) return sendJson(res, 404, { error: 'Трек не найден' });
    if (track.owner_id !== user.id && !user.is_admin) return sendJson(res, 403, { error: 'Недостаточно прав' });
    if (req.method === 'DELETE') {
      if (track.cover_key) {
        const existing = path.resolve(config.storageDir, track.cover_key);
        if (existing.startsWith(config.storageDir + path.sep)) fs.rmSync(existing, { force: true });
      }
      await db.prepare('UPDATE tracks SET cover_key=NULL,cover_checked=1 WHERE id=?').run(track.id);
      return sendJson(res, 200, { ok: true, cover_url: null });
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('image/')) return sendJson(res, 415, { error: 'Нужен файл изображения' });
    const source = path.join(uploadDir, `${crypto.randomUUID()}.cover-source`);
    const converted = path.join(uploadDir, `${crypto.randomUUID()}.cover.jpg`);
    try {
      fs.writeFileSync(source, await readBytes(req, 12 * 1024 * 1024), { mode: 0o640 });
      const ok = await runProcess('ffmpeg', ['-loglevel', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', converted]);
      if (!ok || !fs.existsSync(converted)) return sendJson(res, 400, { error: 'Не удалось прочитать изображение' });
      const shard = track.id.slice(0, 2);
      const destinationDir = path.join(coverDir, shard);
      fs.mkdirSync(destinationDir, { recursive: true, mode: 0o750 });
      const coverKey = path.join('covers', shard, `${track.id}.jpg`);
      fs.renameSync(converted, path.join(config.storageDir, coverKey));
      if (track.cover_key && track.cover_key !== coverKey) {
        const previous = path.resolve(config.storageDir, track.cover_key);
        if (previous.startsWith(config.storageDir + path.sep)) fs.rmSync(previous, { force: true });
      }
      await db.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=?').run(coverKey, track.id);
      return sendJson(res, 200, { ok: true, cover_url: `${apiPrefix}/tracks/${track.id}/cover?v=${Date.now()}` });
    } finally {
      fs.rmSync(source, { force: true });
      fs.rmSync(converted, { force: true });
    }
  }
  const likeMatch=/^\/api\/tracks\/([0-9a-f-]+)\/like$/.exec(url.pathname);
  if(likeMatch&&(req.method==='PUT'||req.method==='DELETE')){
    const track=await db.prepare('SELECT id FROM tracks WHERE id=?').get(likeMatch[1]);
    if(!track)return sendJson(res,404,{error:'Трек не найден'});
    if(req.method==='PUT')await db.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(user.id,track.id);
    else await db.prepare('DELETE FROM track_likes WHERE user_id=? AND track_id=?').run(user.id,track.id);
    return sendJson(res,200,{liked:req.method==='PUT'});
  }
  if (url.pathname === '/api/uploads' && req.method === 'GET') {
    const items = (await db.prepare(`SELECT id,filename,mime_type,total_bytes,received_bytes,status,error,track_id,created_at,updated_at
      FROM uploads WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`).all(user.id)).map(upload => ({
        ...upload, total_bytes: Number(upload.total_bytes), received_bytes: Number(upload.received_bytes),
      }));
    return sendJson(res, 200, { items });
  }
  if (url.pathname === '/api/uploads' && req.method === 'POST') {
    const body = await readJson(req);
    const filename = safeFilename(body.filename);
    const total = Number(body.size);
    if (!filename || !Number.isSafeInteger(total) || total < 1 || total > config.maxUploadBytes) {
      return sendJson(res, 400, { error: 'Некорректное имя или размер файла' });
    }
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO uploads (id,user_id,filename,mime_type,total_bytes) VALUES (?,?,?,?,?)')
      .run(id, user.id, filename, String(body.mime_type || 'application/octet-stream'), total);
    fs.closeSync(fs.openSync(path.join(uploadDir, `${id}.part`), 'wx', 0o640));
    return sendJson(res, 201, { id, offset: 0, size: total });
  }
  const uploadMatch = /^\/api\/uploads\/([0-9a-f-]+)$/.exec(url.pathname);
  if (uploadMatch) {
    const upload = await db.prepare('SELECT * FROM uploads WHERE id=? AND user_id=?').get(uploadMatch[1], user.id);
    if (!upload) return sendJson(res, 404, { error: 'Загрузка не найдена' });
    upload.received_bytes = Number(upload.received_bytes); upload.total_bytes = Number(upload.total_bytes);
    if (req.method === 'GET') return sendJson(res, 200, {
      id: upload.id, offset: upload.received_bytes, size: upload.total_bytes,
      status: upload.status, error: upload.error, track_id: upload.track_id,
    });
    if (req.method === 'HEAD') {
      res.writeHead(204, { 'Upload-Offset': String(upload.received_bytes), 'Upload-Length': String(upload.total_bytes), 'Upload-Status': upload.status });
      return res.end();
    }
    if (req.method === 'PUT') {
      if (upload.status !== 'uploading') return sendJson(res, 409, { error: 'Загрузка уже завершена' });
      const range = parseContentRange(req.headers['content-range']);
      if (!range || range.total !== upload.total_bytes || range.start !== upload.received_bytes) {
        return sendJson(res, 409, { error: 'Неверное смещение', expected_offset: upload.received_bytes });
      }
      const declaredLength = Number(req.headers['content-length']);
      if (declaredLength !== range.length) return sendJson(res, 400, { error: 'Размер части не совпадает с Content-Range' });
      const target = path.join(uploadDir, `${upload.id}.part`);
      const output = fs.createWriteStream(target, { flags: 'r+', start: range.start });
      let written = 0;
      for await (const chunk of req) { written += chunk.length; if (written > range.length) { output.destroy(); return sendJson(res, 400, { error: 'Получено слишком много данных' }); } if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve)); }
      await new Promise((resolve, reject) => output.end(err => err ? reject(err) : resolve()));
      if (written !== range.length) return sendJson(res, 400, { error: 'Получена неполная часть' });
      const next = range.end + 1;
      await db.prepare('UPDATE uploads SET received_bytes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, upload.id);
      if (next === upload.total_bytes) {
        await enqueueUpload(upload.id, crypto.randomUUID());
        return sendJson(res, 202, { offset: next, complete: true, processing: true });
      }
      return sendJson(res, 200, { offset: next, complete: false });
    }
  }
  const coverMatch = /^\/api\/tracks\/([0-9a-f-]+)\/cover$/.exec(url.pathname);
  if (coverMatch && req.method === 'GET') {
    const track = await db.prepare('SELECT cover_key FROM tracks WHERE id=?').get(coverMatch[1]);
    if (!track?.cover_key) { res.writeHead(404); return res.end(); }
    const file = path.resolve(config.storageDir, track.cover_key);
    if (!file.startsWith(config.storageDir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400', 'Vary': 'Cookie' });
    return fs.createReadStream(file).pipe(res);
  }
  const artistImageGetMatch=/^\/api\/artists\/(\d+)\/image$/.exec(url.pathname);
  if(artistImageGetMatch&&req.method==='GET'){
    const artist=await db.prepare('SELECT image_key FROM artists WHERE id=?').get(Number(artistImageGetMatch[1]));if(!artist?.image_key){res.writeHead(404);return res.end();}
    const file=path.resolve(config.storageDir,artist.image_key);if(!file.startsWith(config.storageDir+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600'});return fs.createReadStream(file).pipe(res);
  }
  const albumImageGetMatch=/^\/api\/albums\/(\d+)\/image$/.exec(url.pathname);
  if(albumImageGetMatch&&req.method==='GET'){
    const album=await db.prepare('SELECT image_key FROM albums WHERE id=?').get(Number(albumImageGetMatch[1]));if(!album?.image_key){res.writeHead(404);return res.end();}
    const file=path.resolve(config.storageDir,album.image_key);if(!file.startsWith(config.storageDir+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600','Vary':'Cookie'});return fs.createReadStream(file).pipe(res);
  }
  const streamMatch = /^\/api\/tracks\/([0-9a-f-]+)\/stream$/.exec(url.pathname);
  if (streamMatch && req.method === 'GET') {
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(streamMatch[1]);
    if (!track) return sendJson(res, 404, { error: 'Трек не найден' });
    const requested = String(url.searchParams.get('quality') || 'original');
    const variant = playbackVariant(requested, track.source_codec);
    const prepareVariant = ['aac_96','aac_192'].includes(String(url.searchParams.get('prepare'))) ? String(url.searchParams.get('prepare')) : null;
    if(prepareVariant){const prepared=await db.prepare("SELECT id FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(track.id,prepareVariant);if(!prepared){await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status) VALUES(?,?,'audio/mp4','aac',?,'queued') ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' THEN 'queued' ELSE track_files.status END,updated_at=CURRENT_TIMESTAMP`).run(track.id,prepareVariant,prepareVariant==='aac_96'?96000:192000);}}
    let selected = null;
    if (variant) {
      selected = await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant=? AND status='ready'").get(track.id, variant);
      if (!selected) await db.prepare(`INSERT INTO track_files(track_id,variant,mime_type,codec,bitrate,status) VALUES(?,?,'audio/mp4','aac',?,'queued')
        ON CONFLICT(track_id,variant) DO UPDATE SET status=CASE WHEN track_files.status='failed' THEN 'queued' ELSE track_files.status END,updated_at=CURRENT_TIMESTAMP`).run(track.id, variant, variant === 'aac_96' ? 96000 : 192000);
      // Playback must not wait while an AAC derivative is being built.
      // The original starts immediately; a later request uses the ready variant.
    }
    const storageKey = selected?.storage_key || track.storage_key;
    const mimeType = selected?.mime_type || track.mime_type;
    const actualVariant = selected?.variant || 'original';
    if (!serveStoredMedia(req,res,{storageDir:config.storageDir,storageKey,mimeType,variant:actualVariant,xAccelRedirect:config.xAccelRedirect})) return sendJson(res,404,{error:'Файл не найден'});
    return;
  }
  return sendJson(res, 404, { error: 'Маршрут не найден' });
}

function staticFile(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  httpMetrics.requests++;
  res.once('finish', () => { if (res.statusCode >= 500) httpMetrics.errors5xx++; });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (await acceptFederationPairing(req, res, url)) return;
    if (await federationNotify(req, res, url)) return;
    if (await federationCover(req, res, url)) return;
    if (await federationAudio(req, res, url)) return;
    if (await federationCatalog(req, res, url)) return;
    if (await publicFederation(req, res, url)) return;
    const route = resolveApiRoute(url);
    if (route && !hasValidSessionOrigin(req)) return sendJson(res, 403, { error: 'Недоверенный источник запроса' });
    if (route) {
      res.setHeader('X-API-Version', String(route.version));
      if (route.legacy) {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Link', '</api/v1>; rel="successor-version"');
      }
      return await api(req, res, route.url, route.prefix);
    }
    if (!staticFile(res, url.pathname)) staticFile(res, '/');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
    else res.destroy();
  }
});

function startWorkers() {
  updateWorkerHeartbeat().catch(error => console.error('Ошибка heartbeat worker:', error));
  setInterval(() => updateWorkerHeartbeat().catch(error => console.error('Ошибка heartbeat worker:', error)), 15000);
  enrichExistingTracks().catch(error => console.error('Ошибка фоновой индексации:', error));
  recoverProcessingJobs()
    .then(() => processNextJob())
    .catch(error => console.error('Ошибка восстановления очереди:', error));
  setInterval(() => processNextJob().catch(error => console.error('Ошибка worker:', error)), Math.max(250, config.workerPollMs));
  processNextTranscode().catch(error => console.error('Ошибка transcode worker:', error));
  setInterval(() => processNextTranscode().catch(error => console.error('Ошибка transcode worker:', error)), 2000);
  db.prepare("UPDATE recognition_jobs SET status='retry',available_at=CURRENT_TIMESTAMP WHERE status='processing'").run()
    .then(() => processNextRecognition()).catch(error => console.error('Ошибка восстановления распознавания:', error));
  setInterval(() => processNextRecognition().catch(error => console.error('Ошибка recognition worker:', error)), 5000);
  db.prepare("UPDATE loudness_jobs SET status='retry',available_at=CURRENT_TIMESTAMP WHERE status='processing'").run()
    .then(() => pumpLoudness()).catch(error => console.error('Ошибка восстановления анализа громкости:', error));
  setInterval(pumpLoudness, 3000);
  recoverFederationReplicas().then(()=>processNextFederationReplica()).catch(error=>console.error('Ошибка восстановления реплик:',error));
  setInterval(()=>processNextFederationReplica().catch(error=>console.error('Ошибка worker реплик:',error)),2000);
  cleanupAbandonedUploads().catch(error => console.error('Ошибка очистки загрузок:', error));
  setInterval(() => cleanupAbandonedUploads().catch(error => console.error('Ошибка очистки загрузок:', error)), Math.max(1, config.uploadCleanupMinutes) * 60000);
  cleanupDiagnosticReports().catch(error => console.error('Ошибка ротации отчётов:', error));
  setInterval(() => cleanupDiagnosticReports().catch(error => console.error('Ошибка ротации отчётов:', error)), 6 * 60 * 60 * 1000);
  cleanupFederationData().catch(error=>console.error('Ошибка очистки федерации:',error));
  setInterval(()=>cleanupFederationData().catch(error=>console.error('Ошибка очистки федерации:',error)),6*60*60*1000);
  syncFederationCatalogs().catch(error => console.error('Ошибка federation sync:', error));
  setInterval(() => syncFederationCatalogs().catch(error => console.error('Ошибка federation sync:', error)), 5000);
  notifyFederationPeers().catch(error => console.error('Ошибка federation notify:', error));
  setInterval(() => notifyFederationPeers().catch(error => console.error('Ошибка federation notify:', error)), 5000);
}

if (workerMode) {
  console.log('Family Music worker запущен');
  startWorkers();
} else server.listen(config.port, config.host, () => console.log(`Family Music API: http://${config.host}:${config.port}`));
