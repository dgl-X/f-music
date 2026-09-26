import {
  applyFederationDeltaPage,
  catalogEvent,
  decodeCatalogCursor,
  encodeCatalogCursor,
  federationCatalogRow,
} from './federation-catalog.js';
import { getFederationJson, postFederationJson } from './federation-endpoints.js';
import { FEDERATION_PROTOCOL_MINOR } from './federation-protocol.js';
import {
  signFederationRequest,
  signFederationResponse,
  verifyFederationResponse,
} from './federation-signatures.js';

export function federationRetryDelay(failures, jitter = Math.random()) {
  return Math.min(3600, 15 * 2 ** Math.min(8, Math.max(0, failures - 1))) + Math.floor(jitter * 10);
}

export function createFederationSyncService({
  db,
  federation,
  getJson = getFederationJson,
  postJson = postFederationJson,
  removeReplicaFiles = () => {},
  startOperation = null,
}) {
  let syncBusy = false;
  let notifyBusy = false;

  async function delta({ peerNodeId, identity, cursor, limit }) {
    const after = decodeCatalogCursor(cursor);
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 500));
    const rows = await db.prepare(`SELECT events.revision,events.event_type,events.object_id,events.payload_json,events.occurred_at,tracks.album AS current_album
      FROM federation_catalog_events events LEFT JOIN tracks ON tracks.id=events.object_id
      WHERE events.revision>? ORDER BY events.revision LIMIT ?`).all(after, boundedLimit + 1);
    const exportSettings = await federation.exportSettings(peerNodeId);
    const rawPage = rows.slice(0, boundedLimit);
    const items = rawPage.map(row => federationCatalogRow(row, exportSettings)).map(row => catalogEvent(row, identity.node_id));
    const lastRevision = rawPage.length ? Number(rawPage.at(-1).revision) : after;
    const body = Buffer.from(JSON.stringify({
      protocol_version: 1,
      producer_minor: FEDERATION_PROTOCOL_MINOR,
      min_reader_minor: 0,
      items,
      next_cursor: encodeCatalogCursor(lastRevision),
      has_more: rows.length > boundedLimit,
    }));
    return { body, headers: signFederationResponse(body, identity.node_id, identity.private_key_pem) };
  }

  async function acceptNotification(peerNodeId, latestRevision) {
    const revision = Number(latestRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw Object.assign(new Error('Некорректная latest_revision'), { code: 'invalid_revision' });
    }
    await db.prepare(`UPDATE federation_peers SET remote_latest_revision=GREATEST(remote_latest_revision,?),
      next_sync_at=LEAST(next_sync_at,CURRENT_TIMESTAMP),last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE node_id=?`).run(revision, peerNodeId);
    return { accepted: true, latest_revision: revision };
  }

  async function sync(identity) {
    if (syncBusy) return false;
    syncBusy = true;
    try {
      const peers = await db.prepare("SELECT * FROM federation_peers WHERE status IN ('compatible','limited') AND revoked_at IS NULL AND next_sync_at<=CURRENT_TIMESTAMP ORDER BY next_sync_at LIMIT 4").all();
      for (const peer of peers) {
        const finish = startOperation?.('federation.sync');
        let succeeded = false;
        try {
          let cursor = peer.catalog_cursor || '';
          let pages = 0;
          let hasMore = true;
          while (hasMore && pages++ < 4) {
            const query = new URLSearchParams({ limit: '500' });
            if (cursor) query.set('cursor', cursor);
            const routePath = `/federation/v1/catalog/delta?${query}`;
            const targetUri = `${peer.endpoint.replace(/\/$/, '')}${routePath}`;
            const headers = signFederationRequest({ method:'GET', targetUri, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
            const response = await getJson(peer.endpoint, routePath, headers);
            if (!verifyFederationResponse(response.bytes, response.headers, peer.node_id, peer.public_key)) {
              throw Object.assign(new Error('Подпись ответа каталога не прошла проверку'), { code:'invalid_response_signature' });
            }
            const removed = await applyFederationDeltaPage(db, peer.node_id, response.body);
            for (const replica of removed) await removeReplicaFiles(peer.node_id, replica);
            cursor = response.body.next_cursor;
            hasMore = Boolean(response.body.has_more);
          }
          succeeded = true;
        } catch (error) {
          const failures = Number(peer.sync_failures || 0) + 1;
          await db.prepare("UPDATE federation_peers SET sync_failures=?,sync_error=?,next_sync_at=CURRENT_TIMESTAMP+(?*INTERVAL '1 second'),updated_at=CURRENT_TIMESTAMP WHERE node_id=?")
            .run(failures, String(error.message || error).slice(0, 1000), federationRetryDelay(failures), peer.node_id);
        } finally {
          await finish?.(succeeded);
        }
      }
      return true;
    } finally {
      syncBusy = false;
    }
  }

  async function notify(identity) {
    if (notifyBusy) return false;
    notifyBusy = true;
    try {
      const head = Number((await db.prepare('SELECT COALESCE(max(revision),0) AS revision FROM federation_catalog_events').get()).revision);
      const peers = await db.prepare("SELECT * FROM federation_peers WHERE status IN ('compatible','limited') AND revoked_at IS NULL AND last_notified_revision<? AND next_notify_at<=CURRENT_TIMESTAMP ORDER BY next_notify_at LIMIT 8").all(head);
      for (const peer of peers) try {
        const routePath = '/federation/v1/catalog/notify';
        const targetUri = `${peer.endpoint.replace(/\/$/, '')}${routePath}`;
        const payload = JSON.stringify({ latest_revision:head, changed_at:new Date().toISOString() });
        const headers = signFederationRequest({ method:'POST', targetUri, body:payload, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
        await postJson(peer.endpoint, routePath, payload, headers);
        await db.prepare('UPDATE federation_peers SET last_notified_revision=?,next_notify_at=CURRENT_TIMESTAMP,notify_failures=0,notify_error=NULL WHERE node_id=?').run(head, peer.node_id);
      } catch (error) {
        const failures = Number(peer.notify_failures || 0) + 1;
        await db.prepare("UPDATE federation_peers SET notify_failures=?,notify_error=?,next_notify_at=CURRENT_TIMESTAMP+(?*INTERVAL '1 second') WHERE node_id=?")
          .run(failures, String(error.message || error).slice(0, 1000), federationRetryDelay(failures), peer.node_id);
      }
      return true;
    } finally {
      notifyBusy = false;
    }
  }

  return { delta, acceptNotification, sync, notify };
}
