const PUBLIC_PATHS = new Set([
  '/.well-known/family-music',
  '/federation/v1/node',
  '/federation/v1/health',
]);

const SIGNATURE_ERRORS = new Set([
  'node_mismatch',
  'invalid_nonce',
  'invalid_signature',
  'clock_skew',
  'digest_mismatch',
  'replay_detected',
]);

export function createInboundFederationHttpController({
  federation,
  pairing,
  sync,
  loadIdentity,
  publicNodeDescriptor,
  externalRequestUri,
  verifyRequest,
  readBytes,
  sendJson,
  jsonHeaders,
  softwareVersion,
}) {
  function disabled(res) {
    sendJson(res, 404, { error:{ code:'federation_disabled', message:'Федерация выключена', retryable:false } });
  }

  async function context(res) {
    const settings = await federation.settings();
    const identity = loadIdentity();
    if (!settings.enabled || !identity) {
      disabled(res);
      return null;
    }
    return { settings, identity };
  }

  async function handlePublic(req, res, url) {
    if (req.method !== 'GET' || !PUBLIC_PATHS.has(url.pathname)) return false;
    const state = await context(res);
    if (!state) return true;
    if (url.pathname === '/federation/v1/health') {
      sendJson(res, 200, { status:'ok', node_id:state.identity.node_id, protocol_version:1 });
    } else {
      sendJson(res, 200, publicNodeDescriptor(state.identity, {
        softwareVersion,
        endpoints:state.settings.endpoints,
      }));
    }
    return true;
  }

  async function handlePairing(req, res, url) {
    if (url.pathname !== '/federation/v1/pairing/accept' || req.method !== 'POST') return false;
    try {
      const state = await context(res);
      if (!state) return true;
      const bytes = await readBytes(req, 64 * 1024);
      let body;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        sendJson(res, 400, { error:{ code:'invalid_json', message:'Некорректный JSON', retryable:false } });
        return true;
      }
      const result = await pairing.accept({
        body,
        bytes,
        method:req.method,
        targetUri:externalRequestUri(req, url),
        headers:req.headers,
        settings:state.settings,
        identity:state.identity,
      });
      sendJson(res, 200, result);
    } catch (error) {
      const status = error.status || (SIGNATURE_ERRORS.has(error.code) ? 401 : 400);
      sendJson(res, status, { error:{
        code:error.code || 'invalid_pairing_request',
        message:error.message || 'Некорректный запрос pairing',
        retryable:false,
      } });
    }
    return true;
  }

  async function handleCatalog(req, res, url) {
    if (url.pathname !== '/federation/v1/catalog/delta' || req.method !== 'GET') return false;
    try {
      const state = await context(res);
      if (!state) return true;
      const remoteNodeId = String(req.headers['x-family-music-node'] || '');
      const peer = await federation.trustedPeer(remoteNodeId);
      if (!peer) {
        sendJson(res, 403, { error:{ code:'peer_not_trusted', message:'Нода не подключена или отозвана', retryable:false } });
        return true;
      }
      await verifyRequest({
        method:req.method,
        targetUri:externalRequestUri(req, url),
        headers:req.headers,
        publicKey:peer.public_key,
        expectedNodeId:peer.node_id,
        consumeNonce:federation.consumeNonce,
      });
      const result = await sync.delta({
        peerNodeId:peer.node_id,
        identity:state.identity,
        cursor:url.searchParams.get('cursor'),
        limit:url.searchParams.get('limit'),
      });
      res.writeHead(200, { ...jsonHeaders, ...result.headers });
      res.end(result.body);
    } catch (error) {
      sendJson(res, SIGNATURE_ERRORS.has(error.code) ? 401 : 400, { error:{
        code:error.code || 'catalog_request_failed',
        message:error.message || 'Некорректный запрос каталога',
        retryable:false,
      } });
    }
    return true;
  }

  async function handleNotify(req, res, url) {
    if (url.pathname !== '/federation/v1/catalog/notify' || req.method !== 'POST') return false;
    try {
      const state = await context(res);
      if (!state) return true;
      const bytes = await readBytes(req, 16 * 1024);
      const remoteNodeId = String(req.headers['x-family-music-node'] || '');
      const peer = await federation.trustedPeer(remoteNodeId);
      if (!peer) {
        sendJson(res, 403, { error:{ code:'peer_not_trusted', message:'Нода не подключена или отозвана', retryable:false } });
        return true;
      }
      await verifyRequest({
        method:req.method,
        targetUri:externalRequestUri(req, url),
        body:bytes,
        headers:req.headers,
        publicKey:peer.public_key,
        expectedNodeId:peer.node_id,
        consumeNonce:federation.consumeNonce,
      });
      let body;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw Object.assign(new Error('Некорректный JSON notify'), { code:'invalid_json' });
      }
      sendJson(res, 202, await sync.acceptNotification(peer.node_id, body.latest_revision));
    } catch (error) {
      sendJson(res, SIGNATURE_ERRORS.has(error.code) ? 401 : 400, { error:{
        code:error.code || 'notify_failed',
        message:error.message || 'Некорректный notify',
        retryable:false,
      } });
    }
    return true;
  }

  async function handle(req, res, url) {
    if (await handlePairing(req, res, url)) return true;
    if (await handleNotify(req, res, url)) return true;
    if (await handleCatalog(req, res, url)) return true;
    return handlePublic(req, res, url);
  }

  return { handle };
}
