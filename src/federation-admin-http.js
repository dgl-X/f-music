const ADMIN_PREFIX = '/api/admin/federation';
const COLLECTION_PATH = /^\/api\/admin\/federation\/collections\/([0-9a-f-]{36})$/;
const INVITATION_PATH = /^\/api\/admin\/federation\/invitations\/([0-9a-f-]{36})$/;
const PEER_PATH = /^\/api\/admin\/federation\/peers\/(fm:[A-Za-z0-9_-]{16,128})$/;
const PEER_CHECK_PATH = /^\/api\/admin\/federation\/peers\/(fm:[A-Za-z0-9_-]{16,128})\/check$/;
const PEER_POLICY_PATH = /^\/api\/admin\/federation\/peers\/(fm:[A-Za-z0-9_-]{16,128})\/export-policy$/;

export function createFederationAdminHttpController({
  db,
  federation,
  availability,
  pairing,
  loadIdentity,
  ensureIdentity,
  validateEndpoints,
  parseSettingList,
  decodeInvitationCode,
  encodeInvitationCode,
  probeEndpoint,
  randomId,
  randomToken,
  tokenHash,
  appendVisibilityEvents,
  appendTrackRefreshEvents,
  readJson,
  sendJson,
}) {
  function requireAdmin(res, user) {
    if (user.is_admin) return true;
    sendJson(res, 403, { error:'Доступно только администратору' });
    return false;
  }

  async function settings(req, res, user) {
    if (req.method === 'GET') {
      const current = await federation.settings();
      const identity = loadIdentity();
      const availableAlbums = await db.prepare(`SELECT album AS name,count(*) AS track_count,max(year) AS year,min(artist) AS artist
        FROM tracks WHERE album<>'' GROUP BY album ORDER BY album COLLATE "C" LIMIT 1000`).all();
      const collections = await db.prepare(`SELECT collection.id,collection.name,count(item.track_id) AS track_count
        FROM federation_export_collections collection LEFT JOIN federation_export_collection_tracks item ON item.collection_id=collection.id
        GROUP BY collection.id ORDER BY collection.name COLLATE "C"`).all();
      sendJson(res, 200, {
        ...current,
        available_albums:availableAlbums,
        collections:collections.map(item => ({ ...item, track_count:Number(item.track_count) })),
        initialized:Boolean(identity),
        node_id:identity?.node_id ?? null,
        fingerprint:identity?.fingerprint ?? null,
        created_at:identity?.created_at ?? null,
      });
      return;
    }
    const body = await readJson(req);
    const enabled = Boolean(body.enabled), initialize = Boolean(body.initialize);
    const exportPolicy = ['all', 'albums', 'collections'].includes(body.export_policy) ? body.export_policy : 'none';
    const selectedAlbums = [...new Set((Array.isArray(body.selected_albums) ? body.selected_albums : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
    const selectedCollections = [...new Set((Array.isArray(body.selected_collections) ? body.selected_collections : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
    const existingCollections = selectedCollections.length
      ? (await db.prepare('SELECT id FROM federation_export_collections WHERE id=ANY(?::text[])').all(selectedCollections)).map(item => item.id)
      : [];
    if (existingCollections.length !== selectedCollections.length) {
      sendJson(res, 400, { error:'Выбрана несуществующая коллекция' });
      return;
    }
    const previousSettings = await federation.exportSettings();
    const selectedTrackIds = selectedCollections.length
      ? (await db.prepare('SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])').all(selectedCollections)).map(item => item.track_id)
      : [];
    const nextSettings = { export_policy:exportPolicy, selected_albums:selectedAlbums, selected_collections:selectedCollections, selected_track_ids:selectedTrackIds };
    const endpoints = validateEndpoints(body.endpoints ?? []);
    let identity = loadIdentity();
    if ((initialize || enabled) && !identity) identity = ensureIdentity();
    if (enabled && !identity) {
      sendJson(res, 409, { error:'Сначала создайте identity ноды' });
      return;
    }
    await db.transaction(async tx => {
      const save = tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`);
      await save.run('federation_enabled', enabled ? 'true' : 'false');
      await save.run('federation_endpoints', JSON.stringify(endpoints));
      await save.run('federation_export_policy', exportPolicy);
      await save.run('federation_export_albums', JSON.stringify(selectedAlbums));
      await save.run('federation_export_collections', JSON.stringify(selectedCollections));
      await appendVisibilityEvents(tx, previousSettings, nextSettings);
    });
    sendJson(res, 200, {
      enabled, endpoints, export_policy:exportPolicy, selected_albums:selectedAlbums,
      selected_collections:selectedCollections, initialized:Boolean(identity),
      node_id:identity?.node_id ?? null, fingerprint:identity?.fingerprint ?? null,
      created_at:identity?.created_at ?? null,
    });
  }

  async function collections(req, res, url, user) {
    if (url.pathname === `${ADMIN_PREFIX}/collections` && req.method === 'GET') {
      const items = await db.prepare(`SELECT collection.id,collection.name,collection.created_at,collection.updated_at,count(item.track_id) AS track_count
        FROM federation_export_collections collection LEFT JOIN federation_export_collection_tracks item ON item.collection_id=collection.id
        GROUP BY collection.id ORDER BY collection.name COLLATE "C"`).all();
      sendJson(res, 200, { items:items.map(item => ({ ...item, track_count:Number(item.track_count) })) });
      return true;
    }
    if (url.pathname === `${ADMIN_PREFIX}/collections` && req.method === 'POST') {
      const name = String((await readJson(req)).name || '').trim().slice(0, 120);
      if (!name) sendJson(res, 400, { error:'Укажите название коллекции' });
      else if (await db.prepare('SELECT 1 FROM federation_export_collections WHERE lower(name)=lower(?)').get(name)) sendJson(res, 409, { error:'Коллекция с таким названием уже существует' });
      else {
        const id = randomId();
        await db.prepare('INSERT INTO federation_export_collections(id,name,created_by) VALUES(?,?,?)').run(id, name, user.id);
        sendJson(res, 201, { id, name, track_count:0 });
      }
      return true;
    }
    const match = COLLECTION_PATH.exec(url.pathname);
    if (!match || !['GET', 'PUT', 'DELETE'].includes(req.method)) return false;
    const collection = await db.prepare(req.method === 'GET' ? 'SELECT id,name,created_at,updated_at FROM federation_export_collections WHERE id=?' : 'SELECT id FROM federation_export_collections WHERE id=?').get(match[1]);
    if (!collection) {
      sendJson(res, 404, { error:'Коллекция не найдена' });
      return true;
    }
    if (req.method === 'GET') {
      const tracks = await db.prepare(`SELECT tracks.id,tracks.title,tracks.artist,tracks.album,tracks.duration_seconds
        FROM federation_export_collection_tracks item JOIN tracks ON tracks.id=item.track_id WHERE item.collection_id=?
        ORDER BY tracks.artist COLLATE "C",tracks.album COLLATE "C",tracks.disc_number NULLS LAST,tracks.track_number NULLS LAST,tracks.title COLLATE "C"`).all(collection.id);
      sendJson(res, 200, { ...collection, tracks });
      return true;
    }
    const oldIds = (await db.prepare('SELECT track_id FROM federation_export_collection_tracks WHERE collection_id=?').all(collection.id)).map(item => item.track_id);
    if (req.method === 'DELETE') {
      await db.transaction(async tx => {
        await tx.prepare('DELETE FROM federation_export_collections WHERE id=?').run(collection.id);
        const setting = await tx.prepare("SELECT value FROM app_settings WHERE key='federation_export_collections'").get();
        if (setting) await tx.prepare("UPDATE app_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='federation_export_collections'").run(JSON.stringify(parseSettingList(setting.value).filter(id => id !== collection.id)));
        const rules = await tx.prepare('SELECT peer_node_id,selected_collections_json FROM federation_peer_export_rules').all();
        for (const rule of rules) await tx.prepare('UPDATE federation_peer_export_rules SET selected_collections_json=?,updated_at=CURRENT_TIMESTAMP WHERE peer_node_id=?').run(JSON.stringify(parseSettingList(rule.selected_collections_json).filter(id => id !== collection.id)), rule.peer_node_id);
        await appendTrackRefreshEvents(tx, oldIds);
      });
      sendJson(res, 200, { ok:true });
      return true;
    }
    const body = await readJson(req, 1024 * 1024);
    const name = String(body.name || '').trim().slice(0, 120);
    const trackIds = [...new Set((Array.isArray(body.track_ids) ? body.track_ids : []).map(String))].slice(0, 10000);
    if (!name) {
      sendJson(res, 400, { error:'Укажите название коллекции' });
      return true;
    }
    if (await db.prepare('SELECT 1 FROM federation_export_collections WHERE lower(name)=lower(?) AND id<>?').get(name, collection.id)) {
      sendJson(res, 409, { error:'Коллекция с таким названием уже существует' });
      return true;
    }
    const validIds = trackIds.length ? (await db.prepare('SELECT id FROM tracks WHERE id=ANY(?::text[])').all(trackIds)).map(item => item.id) : [];
    if (validIds.length !== trackIds.length) {
      sendJson(res, 400, { error:'В коллекции указан несуществующий трек' });
      return true;
    }
    await db.transaction(async tx => {
      await tx.prepare('UPDATE federation_export_collections SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, collection.id);
      await tx.prepare('DELETE FROM federation_export_collection_tracks WHERE collection_id=?').run(collection.id);
      for (const trackId of validIds) await tx.prepare('INSERT INTO federation_export_collection_tracks(collection_id,track_id) VALUES(?,?)').run(collection.id, trackId);
      await appendTrackRefreshEvents(tx, [...new Set([...oldIds, ...validIds])]);
    });
    sendJson(res, 200, { id:collection.id, name, track_count:validIds.length });
    return true;
  }

  async function invitations(req, res, url, user) {
    if (url.pathname === `${ADMIN_PREFIX}/invitations` && req.method === 'GET') {
      sendJson(res, 200, { items:await federation.listInvitations() });
      return true;
    }
    if (url.pathname === `${ADMIN_PREFIX}/invitations` && req.method === 'POST') {
      const current = await federation.settings(), identity = loadIdentity();
      if (!current.enabled || !identity) sendJson(res, 409, { error:'Сначала создайте identity и включите федерацию' });
      else {
        const publicEndpoint = current.endpoints.find(item => item.scope === 'public')?.url;
        if (!publicEndpoint) sendJson(res, 409, { error:'Сначала сохраните публичный endpoint' });
        else {
          const minutes = Math.max(5, Math.min(60, Number((await readJson(req)).expires_minutes) || 15));
          const id = randomId(), secret = randomToken(), expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
          await federation.createInvitation({ id, secretHash:tokenHash(secret), endpoint:publicEndpoint, expiresAt, createdBy:user.id });
          const invitation = { version:1, invitation_id:id, issuer_node_id:identity.node_id, endpoint:publicEndpoint, public_key:identity.public_key, secret, expires_at:expiresAt };
          sendJson(res, 201, { invitation, code:encodeInvitationCode(invitation) });
        }
      }
      return true;
    }
    const match = INVITATION_PATH.exec(url.pathname);
    if (!match || req.method !== 'DELETE') return false;
    if (!await federation.revokeInvitation(match[1])) sendJson(res, 404, { error:'Активное приглашение не найдено' });
    else sendJson(res, 200, { ok:true });
    return true;
  }

  async function peers(req, res, url) {
    if (url.pathname === `${ADMIN_PREFIX}/peers` && req.method === 'GET') {
      sendJson(res, 200, { items:await federation.listPeers() });
      return true;
    }
    const check = PEER_CHECK_PATH.exec(url.pathname);
    if (check && req.method === 'POST') {
      try {
        const result = await availability.checkPeer(check[1], probeEndpoint);
        if (!result) sendJson(res, 404, { error:'Активная нода не найдена' });
        else sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 422, { error:error.message || 'Нода недоступна', code:error.code || 'peer_check_failed' });
      }
      return true;
    }
    const policyMatch = PEER_POLICY_PATH.exec(url.pathname);
    if (policyMatch && req.method === 'PUT') {
      const peer = await db.prepare('SELECT node_id FROM federation_peers WHERE node_id=? AND revoked_at IS NULL').get(policyMatch[1]);
      if (!peer) {
        sendJson(res, 404, { error:'Активная нода не найдена' });
        return true;
      }
      const body = await readJson(req);
      const policy = ['inherit', 'none', 'all', 'albums', 'collections'].includes(body.policy) ? body.policy : 'inherit';
      const selectedAlbums = [...new Set((Array.isArray(body.selected_albums) ? body.selected_albums : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
      const selectedCollections = [...new Set((Array.isArray(body.selected_collections) ? body.selected_collections : []).map(String))].slice(0, 1000);
      const existing = selectedCollections.length ? (await db.prepare('SELECT id FROM federation_export_collections WHERE id=ANY(?::text[])').all(selectedCollections)).map(item => item.id) : [];
      if (existing.length !== selectedCollections.length) {
        sendJson(res, 400, { error:'Выбрана несуществующая коллекция' });
        return true;
      }
      const previous = await federation.exportSettings(peer.node_id);
      const selectedTrackIds = selectedCollections.length ? (await db.prepare('SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])').all(selectedCollections)).map(item => item.track_id) : [];
      const global = await federation.exportSettings();
      const next = policy === 'inherit' ? global : { ...global, export_policy:policy, selected_albums:selectedAlbums, selected_collections:selectedCollections, selected_track_ids:selectedTrackIds };
      await db.transaction(async tx => {
        await tx.prepare(`INSERT INTO federation_peer_export_rules(peer_node_id,policy,selected_albums_json,selected_collections_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(peer_node_id) DO UPDATE SET policy=excluded.policy,selected_albums_json=excluded.selected_albums_json,selected_collections_json=excluded.selected_collections_json,updated_at=CURRENT_TIMESTAMP`).run(peer.node_id, policy, JSON.stringify(selectedAlbums), JSON.stringify(selectedCollections));
        await appendVisibilityEvents(tx, previous, next);
      });
      sendJson(res, 200, { ok:true, policy, selected_albums:selectedAlbums, selected_collections:selectedCollections });
      return true;
    }
    const peerMatch = PEER_PATH.exec(url.pathname);
    if (!peerMatch || req.method !== 'DELETE') return false;
    if (!await federation.revokePeer(peerMatch[1])) sendJson(res, 404, { error:'Активная нода не найдена' });
    else sendJson(res, 200, { ok:true });
    return true;
  }

  async function accept(req, res) {
    try {
      const current = await federation.settings(), identity = loadIdentity();
      if (!current.enabled || !identity) sendJson(res, 409, { error:'Сначала создайте identity и включите федерацию' });
      else if (!current.endpoints.some(item => item.scope === 'public')) sendJson(res, 409, { error:'Сначала сохраните публичный endpoint этой ноды' });
      else {
        const invitation = decodeInvitationCode((await readJson(req)).code);
        if (!invitation) sendJson(res, 400, { error:'Некорректный код приглашения' });
        else if (invitation.version !== 1 || !invitation.invitation_id || !invitation.secret || Date.parse(invitation.expires_at) <= Date.now()) sendJson(res, 400, { error:'Приглашение повреждено или истекло' });
        else sendJson(res, 200, await pairing.connect({ invitation, identity, settings:current }));
      }
    } catch (error) {
      sendJson(res, error.status || 422, { error:error.message || 'Не удалось подключить ноду', code:error.code || 'pairing_failed' });
    }
  }

  async function handle(req, res, url, user) {
    if (!url.pathname.startsWith(ADMIN_PREFIX)) return false;
    const known = (url.pathname === ADMIN_PREFIX && ['GET', 'PUT'].includes(req.method))
      || (url.pathname === `${ADMIN_PREFIX}/collections` && ['GET', 'POST'].includes(req.method))
      || (COLLECTION_PATH.test(url.pathname) && ['GET', 'PUT', 'DELETE'].includes(req.method))
      || (url.pathname === `${ADMIN_PREFIX}/check-endpoint` && req.method === 'POST')
      || (url.pathname === `${ADMIN_PREFIX}/invitations` && ['GET', 'POST'].includes(req.method))
      || (INVITATION_PATH.test(url.pathname) && req.method === 'DELETE')
      || (url.pathname === `${ADMIN_PREFIX}/peers` && req.method === 'GET')
      || (PEER_PATH.test(url.pathname) && req.method === 'DELETE')
      || (PEER_CHECK_PATH.test(url.pathname) && req.method === 'POST')
      || (PEER_POLICY_PATH.test(url.pathname) && req.method === 'PUT')
      || (url.pathname === `${ADMIN_PREFIX}/accept` && req.method === 'POST');
    if (!known) return false;
    if (!requireAdmin(res, user)) return true;
    if (url.pathname === ADMIN_PREFIX && ['GET', 'PUT'].includes(req.method)) {
      await settings(req, res, user);
      return true;
    }
    if (await collections(req, res, url, user)) return true;
    if (url.pathname === `${ADMIN_PREFIX}/check-endpoint` && req.method === 'POST') {
      const body = await readJson(req), scope = body.scope === 'private' ? 'private' : 'public';
      try { sendJson(res, 200, await probeEndpoint(body.url, scope)); }
      catch (error) { sendJson(res, 422, { error:error.message, code:error.code || 'endpoint_check_failed' }); }
      return true;
    }
    if (await invitations(req, res, url, user)) return true;
    if (await peers(req, res, url)) return true;
    if (url.pathname === `${ADMIN_PREFIX}/accept` && req.method === 'POST') {
      await accept(req, res);
      return true;
    }
    return false;
  }

  return { handle };
}
