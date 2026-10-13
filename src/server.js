import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { ensureFederationIdentity, loadFederationIdentity, publicNodeDescriptor } from './federation-identity.js';
import { decodeRemoteReference, encodeRemoteReference, federationTrackVisible } from './federation-catalog.js';
import { openFederationStream, probeFederationEndpoint } from './federation-endpoints.js';
import { verifyFederationRequest } from './federation-signatures.js';
import { resolveApiRoute } from './routing.js';
import { parseCookies, randomToken, tokenHash } from './security.js';
import { normalizeHybridFlac } from './audio-normalization.js';
import { audioCodec, playbackVariant, requiresCompatibilityVariant } from './audio-compatibility.js';
import { serveStoredMedia } from './media-stream.js';
import { createAuthenticationService, hasValidSessionOrigin, requestIp, sessionCookie } from './authentication.js';
import { validateAudioDecode } from './audio-validation.js';
import { createCatalogService } from './catalog-service.js';
import { savePlaybackState } from './playback-state.js';
import { createUploadJobService } from './upload-jobs.js';
import { createUploadService } from './upload-service.js';
import { createUploadProcessor } from './upload-processor.js';
import { createCoverExtractor, inspectAudio, runProcess, sha256File } from './media-tools.js';
import { createFederationService, decodeFederationInvitationCode, encodeFederationInvitationCode, externalFederationRequestUri, parseFederationSettingList, validateFederationEndpoints } from './federation-service.js';
import { createFederationPairingService } from './federation-pairing.js';
import { createFederationSyncService } from './federation-sync.js';
import { createFederationMediaService } from './federation-media.js';
import { createFederationImportService, federationReplicaPaths as importReplicaPaths, federationSourceId } from './federation-import.js';
import { createFederationAvailabilityService, FEDERATION_QUEUE_ONLINE_SQL } from './federation-availability.js';
import { createHttpObserver } from './http-observability.js';
import { normalizeErrorResponse } from './api-errors.js';
import { createOperationMetrics } from './operation-metrics.js';
import { createOpenVkProvider } from './openvk-provider.js';
import { createOpenVkHttpController } from './openvk-http.js';
import { createAdminObservabilityService } from './admin-observability.js';
import { createDiagnosticReportsHttpController, createDiagnosticReportsService } from './diagnostic-reports.js';
import { createLoudnessHttpController, createLoudnessService } from './loudness-service.js';
import { createRecognitionService } from './recognition-service.js';
import { createRecognitionHttpController } from './recognition-http.js';
import { createTranscodeService } from './transcode-service.js';
import { createWorkerMaintenance } from './worker-maintenance.js';
import { createConnectService } from './connect-service.js';
import { createConnectHttpController } from './connect-http.js';
import { createAccountHttpController } from './account-http.js';
import { createAuthenticationHttpController } from './authentication-http.js';
import { createOperationalHttpController } from './operational-http.js';
import { createUploadHttpController } from './upload-http.js';
import { createInboundFederationHttpController } from './federation-http.js';
import { createFederationAdminHttpController } from './federation-admin-http.js';
import { createFederationUserHttpController } from './federation-user-http.js';
import { createLibraryHttpController } from './library-http.js';
import { createCollectionHttpController } from './collection-http.js';
import { createDiscoveryHttpController } from './discovery-http.js';
import { createArtistAlbumHttpController } from './artist-album-http.js';
import { createPlaybackHttpController } from './playback-http.js';
import { createTrackManagementHttpController } from './track-management-http.js';
import { createStreamingHttpController } from './streaming-http.js';
import { createStaticFileHandler, createUserAccess, readBytes, readJson, setBrowserSecurityHeaders } from './http-runtime.js';
import { createFederationCatalogEvents } from './federation-catalog-events.js';
import { createUploadWorker } from './upload-worker.js';
import { createWorkerRuntime } from './worker-runtime.js';

const config = loadConfig();
const db = await openDatabase(config.databaseUrl);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const softwareVersion = JSON.parse(fs.readFileSync(path.join(publicDir, '../package.json'), 'utf8')).version;
const uploadDir = path.join(config.storageDir, 'uploads');
const originalDir = path.join(config.storageDir, 'originals');
const coverDir = path.join(config.storageDir, 'covers');
const artistDir = path.join(config.storageDir, 'artists');
const albumDir = path.join(config.storageDir, 'albums');
const federationReplicaDir = path.join(config.storageDir, 'federation', 'replicas');
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(originalDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(coverDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(artistDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(albumDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(federationReplicaDir, { recursive: true, mode: 0o750 });

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const authentication = createAuthenticationService({ db, sessionDays: config.sessionDays, secureCookies: config.secureCookies });
const catalog = createCatalogService({ db, apiPrefix: '/api' });
const uploadJobs = createUploadJobService({ db });
const connect = createConnectService({ db, enabled:config.connectEnabled });
const federation = createFederationService({ db });
const federationAvailability = createFederationAvailabilityService({ db });
const operationMetrics = createOperationMetrics({ db });
const federationPairing = createFederationPairingService({ federation, softwareVersion, randomToken, tokenHash });
const federationSync = createFederationSyncService({
  db,
  federation,
  removeReplicaFiles(nodeId, replica) {
    if (replica.storageKey) {
      const file = path.resolve(config.storageDir, replica.storageKey);
      if (file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`)) fs.rmSync(file, { force:true });
    }
    fs.rmSync(importReplicaPaths(config.storageDir, nodeId, replica.objectId).temporaryPath, { force:true });
  },
  startOperation: operationMetrics.start,
});
const uploads = createUploadService({ db, uploadDir, maxUploadBytes:config.maxUploadBytes, uploadJobs });
const openVk = createOpenVkProvider({ db, uploadDir, maxUploadBytes:config.maxUploadBytes });
const extractCover = createCoverExtractor({ coverDir, storageDir:config.storageDir });
const recognition = createRecognitionService({ db, storageDir:config.storageDir, uploadDir, extractCover, defaultEnabled:config.recognitionEnabled, defaultClientKey:config.acoustIdClientKey });
const uploadProcessor = createUploadProcessor({
  db, uploadDir, originalDir, storageDir:config.storageDir, inspectAudio, sha256File,
  validateAudioDecode, extractCover, normalizeHybridFlac, normalizedTags, audioCodec,
  recognitionSettings:recognition.settings, requiresCompatibilityVariant,
});
const workerMode = process.argv.includes('--worker');
const processStartedAt = new Date();
const httpMetrics = { requests:0, errors5xx:0, duration_ms_total:0, duration_ms_max:0, slow_requests:0 };
const observeHttp = createHttpObserver({ metrics:httpMetrics });
const sendJson = (res, status, value, extra = {}) => {
  res.writeHead(status, { ...jsonHeaders, ...extra });
  res.end(JSON.stringify(normalizeErrorResponse(status, value, res.getHeader('X-Request-ID'))));
};
const userAccess = createUserAccess({
  authentication,
  parseCookies,
  requestIp,
  sessionCookie,
  sessionDays:config.sessionDays,
  secureCookies:config.secureCookies,
  sendJson,
});
const staticFile = createStaticFileHandler(publicDir);
const federationCatalogEvents = createFederationCatalogEvents({ db, federationTrackVisible });
const connectHttp = createConnectHttpController({ connect, readJson, sendJson });
const accountHttp = createAccountHttpController({ db, authentication, registrationEnabled, readJson, sendJson });
const authenticationHttp = createAuthenticationHttpController({ db, authentication, registrationEnabled, readJson, sendJson });
const uploadHttp = createUploadHttpController({ uploads, readJson, sendJson });
const openVkHttp = createOpenVkHttpController({ db, provider:openVk, readJson, sendJson });
const federationMedia = createFederationMediaService({
  db,
  federation,
  availability: federationAvailability,
  storageDir: config.storageDir,
  loadIdentity: () => loadFederationIdentity(config.storageDir),
  sendJson,
});
const adminObservability = createAdminObservabilityService({
  db, storageDir:config.storageDir, processStartedAt, httpMetrics,
  federationStats:() => federationMedia.stats(),
});
const operationalHttp = createOperationalHttpController({
  db,
  storageDir:config.storageDir,
  workerMode,
  softwareVersion,
  metricsToken:config.metricsToken,
  registrationEnabled,
  observability:adminObservability,
  sendJson,
});
const diagnosticReports = createDiagnosticReportsService({
  db,
  retentionDays:config.diagnosticRetentionDays,
  fixedRetentionDays:config.diagnosticFixedRetentionDays,
});
const diagnosticReportsHttp = createDiagnosticReportsHttpController({ reports:diagnosticReports, readJson, sendJson });
const loudness = createLoudnessService({
  db,
  storageDir:config.storageDir,
  startOperation:operationMetrics.start,
});
const loudnessHttp = createLoudnessHttpController({ loudness, sendJson });
const recognitionHttp = createRecognitionHttpController({ db, recognition, readJson, sendJson });
const transcoding = createTranscodeService({ db, storageDir:config.storageDir, execute:runProcess, startOperation:operationMetrics.start });
const maintenance = createWorkerMaintenance({
  db,storageDir:config.storageDir,uploadDir,abandonedUploadHours:config.abandonedUploadHours,
  diagnosticReports,inspectAudio,sha256File,extractCover,normalizedTags,
});
const federationImport = createFederationImportService({
  db,
  storageDir: config.storageDir,
  uploadDir,
  originalDir,
  loadIdentity: () => loadFederationIdentity(config.storageDir),
  extractCover,
  sha256File,
  startOperation: operationMetrics.start,
});
const inboundFederationHttp = createInboundFederationHttpController({
  federation,
  pairing:federationPairing,
  sync:federationSync,
  loadIdentity:() => loadFederationIdentity(config.storageDir),
  publicNodeDescriptor,
  externalRequestUri:externalFederationRequestUri,
  verifyRequest:verifyFederationRequest,
  readBytes,
  sendJson,
  jsonHeaders,
  softwareVersion,
});
const federationAdminHttp = createFederationAdminHttpController({
  db,
  federation,
  availability:federationAvailability,
  pairing:federationPairing,
  loadIdentity:() => loadFederationIdentity(config.storageDir),
  ensureIdentity:() => ensureFederationIdentity(config.storageDir),
  validateEndpoints:validateFederationEndpoints,
  parseSettingList:parseFederationSettingList,
  decodeInvitationCode:decodeFederationInvitationCode,
  encodeInvitationCode:encodeFederationInvitationCode,
  probeEndpoint:probeFederationEndpoint,
  randomId:crypto.randomUUID,
  randomToken,
  tokenHash,
  appendVisibilityEvents:federationCatalogEvents.appendVisibilityEvents,
  appendTrackRefreshEvents:federationCatalogEvents.appendTrackRefreshEvents,
  readJson,
  sendJson,
});
const federationUserHttp = createFederationUserHttpController({
  db,
  media:federationMedia,
  queueOnlineSql:FEDERATION_QUEUE_ONLINE_SQL,
  encodeReference:encodeRemoteReference,
  decodeReference:decodeRemoteReference,
  sourceId:federationSourceId,
  removeReplicaFiles(nodeId, objectId, storageKey) {
    if (storageKey) {
      const file = path.resolve(config.storageDir, storageKey);
      if (file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`)) fs.rmSync(file, { force:true });
    }
    fs.rmSync(importReplicaPaths(config.storageDir, nodeId, objectId).temporaryPath, { force:true });
  },
  readJson,
  sendJson,
});
const libraryHttp = createLibraryHttpController({
  db,
  queueOnlineSql:FEDERATION_QUEUE_ONLINE_SQL,
  encodeReference:encodeRemoteReference,
  sendJson,
});
const collectionHttp = createCollectionHttpController({
  catalog,
  db,
  encodeReference:encodeRemoteReference,
  decodeReference:decodeRemoteReference,
  readJson,
  sendJson,
});
const discoveryHttp = createDiscoveryHttpController({
  catalog,
  db,
  decodeReference:decodeRemoteReference,
  readJson,
  sendJson,
});
const artistAlbumHttp = createArtistAlbumHttpController({
  catalog,
  db,
  storageDir:config.storageDir,
  uploadDir,
  artistDir,
  albumDir,
  readJson,
  readBytes,
  runProcess,
  sendJson,
});
const playbackHttp = createPlaybackHttpController({
  db,
  decodeRemoteReference,
  savePlaybackState,
  readJson,
  sendJson,
});
const trackManagementHttp = createTrackManagementHttpController({
  catalog,
  db,
  storageDir:config.storageDir,
  uploadDir,
  coverDir,
  readJson,
  readBytes,
  runProcess,
  sendJson,
});
const streamingHttp = createStreamingHttpController({
  db,
  storageDir:config.storageDir,
  xAccelRedirect:config.xAccelRedirect,
  playbackVariant,
  serveStoredMedia,
  sendJson,
});
const uploadWorker = createUploadWorker({
  db,
  uploadJobs,
  uploadProcessor,
  startOperation:operationMetrics.start,
});
const workerRuntime = createWorkerRuntime({
  config,
  maintenance,
  uploadJobs,
  uploadWorker,
  transcoding,
  recognition,
  loudness,
  federationImport,
  federation,
  federationSync,
  federationAvailability,
  loadFederationIdentity:() => loadFederationIdentity(config.storageDir),
  probeFederationEndpoint,
});

async function registrationEnabled() {
  const row=await db.prepare("SELECT value FROM app_settings WHERE key='registration_enabled'").get();
  return row===undefined?config.registrationEnabled:row.value==='true';
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

async function api(req, res, url, apiPrefix = '/api') {
  if (await operationalHttp.handlePublic(req, res, url)) return;
  if (await authenticationHttp.handle(req, res, url)) return;
  const user = await userAccess.requireUser(req, res);
  if (!user) return;
  if (await connectHttp.handle(req, res, url, user)) return;
  if (await accountHttp.handle(req, res, url, user)) return;
  if (await operationalHttp.handleAdmin(req, res, url, user)) return;
  if (await openVkHttp.handle(req,res,url,user)) return;
  if (await diagnosticReportsHttp.handle(req,res,url,user)) return;
  if (await loudnessHttp.handle(req,res,url,user)) return;
  if (await recognitionHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await federationAdminHttp.handle(req,res,url,user)) return;
  if (await federationUserHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await libraryHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await collectionHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await discoveryHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await artistAlbumHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await playbackHttp.handle(req,res,url,user)) return;
  if (await trackManagementHttp.handle(req,res,url,user,apiPrefix)) return;
  if (await uploadHttp.handle(req, res, url, user)) return;
  if (await streamingHttp.handle(req,res,url)) return;
  return sendJson(res, 404, { error: 'Маршрут не найден' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  setBrowserSecurityHeaders(req, res);
  observeHttp(req, res, url);
  try {
    if (await inboundFederationHttp.handle(req, res, url)) return;
    if (await federationMedia.serveCover(req, res, url)) return;
    if (await federationMedia.serveAudio(req, res, url)) return;
    const route = resolveApiRoute(url);
    if (route?.retired) return sendJson(res, 410, {
      error:'Эта версия API отключена. Используйте /api/v1',
      error_code:'api_version_retired',
      retryable:false,
    }, { Link:'</api/v1>; rel="successor-version"' });
    if (route && !hasValidSessionOrigin(req)) return sendJson(res, 403, { error: 'Недоверенный источник запроса' });
    if (route) {
      res.setHeader('X-API-Version', String(route.version));
      return await api(req, res, route.url, route.prefix);
    }
    if (!staticFile(res, url.pathname)) staticFile(res, '/');
  } catch (error) {
    console.error(JSON.stringify({ time:new Date().toISOString(), level:'error', event:'request_error', request_id:req.requestId, method:req.method, path:url.pathname, error_code:error.code || 'internal_error', message:String(error.message || error).slice(0,1000) }));
    if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
    else res.destroy();
  }
});

if (workerMode) {
  console.log('Family Music worker запущен');
  workerRuntime.start();
} else server.listen(config.port, config.host, () => console.log(`Family Music API: http://${config.host}:${config.port}`));
