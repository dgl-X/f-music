import { validateDeltaCompatibility } from './federation-protocol.js';

const CURSOR_PREFIX = 'fm-cursor-v1:';

export function federationTrackVisible(track, settings) {
  if (settings.export_policy === 'all') return true;
  return settings.export_policy === 'albums' && settings.selected_albums.includes(String(track?.album || ''));
}

export function federationCatalogRow(row, settings) {
  if (row.event_type === 'track.upsert.v1' && federationTrackVisible({ album: row.current_album }, settings)) {
    const { policy_event: ignored, ...payload } = row.payload_json || {};
    return { ...row, payload_json: payload };
  }
  return { ...row, event_type: 'track.delete.v1', payload_json: {} };
}

export function encodeCatalogCursor(revision) {
  const value = Number(revision);
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Некорректная ревизия'), { code: 'invalid_cursor' });
  return `${CURSOR_PREFIX}${Buffer.from(String(value)).toString('base64url')}`;
}

export function decodeCatalogCursor(cursor) {
  if (!cursor) return 0;
  const value = String(cursor);
  if (!value.startsWith(CURSOR_PREFIX) || value.length > 128) throw Object.assign(new Error('Некорректный cursor'), { code: 'invalid_cursor' });
  const decoded = Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8');
  if (!/^(0|[1-9][0-9]*)$/.test(decoded)) throw Object.assign(new Error('Некорректный cursor'), { code: 'invalid_cursor' });
  const revision = Number(decoded);
  if (!Number.isSafeInteger(revision)) throw Object.assign(new Error('Некорректный cursor'), { code: 'invalid_cursor' });
  return revision;
}

export function catalogEvent(row, originId) {
  return {
    revision: Number(row.revision), type: row.event_type, event_version: 1, critical: true,
    origin_id: originId, object_id: row.object_id, occurred_at: new Date(row.occurred_at).toISOString(),
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : (row.payload_json || {}),
  };
}

export function encodeRemoteReference(nodeId, objectId) {
  if (!/^fm:[A-Za-z0-9_-]{16,128}$/.test(String(nodeId)) || !objectId || String(objectId).length > 160) throw new Error('Некорректная remote reference');
  return Buffer.from(`${nodeId}\n${objectId}`).toString('base64url');
}

export function decodeRemoteReference(reference) {
  if (!reference || String(reference).length > 512) throw new Error('Некорректная remote reference');
  const [nodeId, objectId, ...extra] = Buffer.from(String(reference), 'base64url').toString('utf8').split('\n');
  if (extra.length || !/^fm:[A-Za-z0-9_-]{16,128}$/.test(nodeId || '') || !objectId || objectId.length > 160) throw new Error('Некорректная remote reference');
  return { nodeId, objectId };
}

export async function applyFederationDeltaPage(db, peerNodeId, page) {
  if (page?.protocol_version !== 1 || !Array.isArray(page.items) || page.items.length > 500 || typeof page.next_cursor !== 'string') {
    throw Object.assign(new Error('Некорректная delta-страница'), { code: 'invalid_delta' });
  }
  validateDeltaCompatibility(page);
  return db.transaction(async tx => {
    const removed = [];
    for (const item of page.items) {
      if (item.origin_id !== peerNodeId || !Number.isSafeInteger(item.revision) || item.revision < 1) {
        throw Object.assign(new Error('Некорректный origin/revision события'), { code: 'invalid_delta' });
      }
      if (item.type === 'track.delete.v1') {
        const replica = await tx.prepare('SELECT storage_key FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(peerNodeId,item.object_id);
        const deleted = await tx.prepare('DELETE FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=? AND revision<=? RETURNING object_id').run(peerNodeId,item.object_id,item.revision);
        if (deleted.changes) removed.push({ objectId:item.object_id, storageKey:replica?.storage_key || null });
      } else if (item.type === 'track.upsert.v1') {
        const p = item.payload || {};
        await tx.prepare(`INSERT INTO federation_remote_tracks(origin_node_id,object_id,revision,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_available,origin_created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin_node_id,object_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,artist=excluded.artist,album=excluded.album,genre=excluded.genre,year=excluded.year,duration_seconds=excluded.duration_seconds,track_number=excluded.track_number,disc_number=excluded.disc_number,cover_available=excluded.cover_available,origin_created_at=excluded.origin_created_at,updated_at=CURRENT_TIMESTAMP WHERE federation_remote_tracks.revision<excluded.revision`)
          .run(peerNodeId,item.object_id,item.revision,String(p.title||'').slice(0,500),String(p.artist||'').slice(0,500),String(p.album||'').slice(0,500),String(p.genre||'').slice(0,200),Number.isInteger(p.year)?p.year:null,Number.isFinite(p.duration_seconds)?p.duration_seconds:null,Number.isInteger(p.track_number)?p.track_number:null,Number.isInteger(p.disc_number)?p.disc_number:null,p.cover_available?1:0,p.created_at||null);
      } else if (item.critical) {
        throw Object.assign(new Error(`Неизвестное обязательное событие ${item.type}`), { code: 'unsupported_event' });
      }
    }
    await tx.prepare("UPDATE federation_peers SET catalog_cursor=?,last_synced_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,next_sync_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes',sync_failures=0,sync_error=NULL WHERE node_id=?").run(page.next_cursor,peerNodeId);
    return removed;
  });
}
