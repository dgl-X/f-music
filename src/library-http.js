const SORTS = {
  newest:'created_at DESC NULLS LAST',
  oldest:'created_at ASC NULLS LAST',
  title:'title COLLATE "C"',
  artist:'artist COLLATE "C",title COLLATE "C"',
  album:'album COLLATE "C",disc_number NULLS LAST,track_number NULLS LAST,title COLLATE "C"',
  year:'year DESC NULLS LAST,title COLLATE "C"',
};

const FAVORITE_SORTS = {
  ...SORTS,
  newest:'liked_at DESC',
  oldest:'liked_at ASC',
};

export function createLibraryHttpController({ db, queueOnlineSql, encodeReference, sendJson }) {
  function parameters(url, queueLimit = 10000) {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    const queueRequest = url.searchParams.get('queue') === '1';
    return {
      query,
      queueRequest,
      limit:Math.min(queueRequest ? queueLimit : 200, Math.max(1, Number(url.searchParams.get('limit')) || 50)),
      offset:Math.max(0, Number(url.searchParams.get('offset')) || 0),
    };
  }

  function remoteAvailability(row) {
    if (row.revoked_at || row.peer_status === 'revoked') return 'revoked';
    if (row.sync_error || !row.last_synced_at || new Date(row.last_synced_at) < new Date(Date.now() - 10 * 60 * 1000)) return 'offline';
    return 'online';
  }

  function localItem(row, apiPrefix, liked = row.liked) {
    const { kind, cover_key, ...track } = row;
    return { ...track, liked, cover_url:cover_key ? `${apiPrefix}/tracks/${row.id}/cover` : null };
  }

  function remoteItem(row, apiPrefix, liked = row.liked) {
    const remoteRef = encodeReference(row.origin_node_id, row.id);
    const state = remoteAvailability(row);
    return {
      ...row,
      kind:undefined,
      id:`remote:${remoteRef}`,
      remote:true,
      remote_ref:remoteRef,
      liked,
      availability:state,
      stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remoteRef)}&quality=original`,
      cover_url:null,
      source_label:row.label || row.endpoint,
      stream_available:row.replica_status === 'ready' || state === 'online',
    };
  }

  async function favorites(res, url, user, apiPrefix) {
    const { query, queueRequest, limit, offset } = parameters(url);
    const sortSql = FAVORITE_SORTS[url.searchParams.get('sort')] || FAVORITE_SORTS.newest;
    const params = { user_id:user.id, query:`%${query}%`, limit, offset };
    const queueOnline = queueRequest ? `AND ${queueOnlineSql}` : '';
    const filter = query ? 'AND (title ILIKE @query OR artist ILIKE @query OR album ILIKE @query OR genre ILIKE @query)' : '';
    const total = Number((await db.prepare(`SELECT
      (SELECT count(*) FROM track_likes likes JOIN tracks ON tracks.id=likes.track_id WHERE likes.user_id=@user_id ${filter})+
      (SELECT count(*) FROM federation_remote_likes likes JOIN federation_remote_tracks remote ON remote.origin_node_id=likes.origin_node_id AND remote.object_id=likes.object_id JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE likes.user_id=@user_id ${queueOnline} ${filter}) count`).get(params)).count);
    const rows = await db.prepare(`SELECT * FROM (
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
      WHERE likes.user_id=@user_id ${queueOnline} ${filter}
    ) favorites ORDER BY ${sortSql},kind,origin_node_id NULLS FIRST,id LIMIT @limit OFFSET @offset`).all(params);
    const items = rows.map(row => row.kind === 'local' ? localItem(row, apiPrefix, true) : remoteItem(row, apiPrefix, true));
    sendJson(res, 200, { items, total, limit, offset, has_more:offset + items.length < total });
  }

  async function library(res, url, user, apiPrefix) {
    const { query, queueRequest, limit, offset } = parameters(url);
    const scope = ['local', 'remote'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'all';
    const sortSql = SORTS[url.searchParams.get('sort')] || SORTS.newest;
    const params = { user_id:user.id, query:`%${query}%`, limit, offset };
    const filter = query ? 'AND (title ILIKE @query OR artist ILIKE @query OR album ILIKE @query OR genre ILIKE @query)' : '';
    const queueOnline = queueRequest ? `AND ${queueOnlineSql}` : '';
    const localSql = scope === 'remote' ? '' : `SELECT 'local' kind,tracks.id,NULL::text origin_node_id,tracks.title,tracks.artist,tracks.album,tracks.filename,tracks.mime_type,tracks.size_bytes,tracks.duration_seconds,tracks.created_at,tracks.genre,tracks.year,tracks.track_number,tracks.disc_number,tracks.cover_key,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.user_id=@user_id AND track_likes.track_id=tracks.id) liked,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') replay_gain_db,
      EXISTS(SELECT 1 FROM track_files WHERE track_files.track_id=tracks.id AND variant='aac_192' AND status='ready') aac_192_ready,
      EXISTS(SELECT 1 FROM track_files WHERE track_files.track_id=tracks.id AND variant='aac_96' AND status='ready') aac_96_ready,
      NULL::text endpoint,NULL::text label,NULL::text peer_status,NULL::timestamptz revoked_at,NULL::timestamptz last_synced_at,NULL::text sync_error
      FROM tracks WHERE TRUE ${filter}`;
    const importedFilter = scope === 'all' ? "AND NOT EXISTS(SELECT 1 FROM track_sources source WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\\n'||remote.object_id)" : '';
    const remoteSql = scope === 'local' ? '' : `SELECT 'remote' kind,remote.object_id id,remote.origin_node_id,remote.title,remote.artist,remote.album,'' filename,'' mime_type,NULL::bigint size_bytes,remote.duration_seconds,remote.origin_created_at created_at,remote.genre,remote.year,remote.track_number,remote.disc_number,NULL::text cover_key,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) liked,
      NULL::double precision replay_gain_db,FALSE aac_192_ready,FALSE aac_96_ready,peer.endpoint,peer.label,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${queueOnline} ${importedFilter} ${filter}`;
    const union = [localSql, remoteSql].filter(Boolean).join(' UNION ALL ');
    const total = Number((await db.prepare(`SELECT count(*) count FROM (${union}) library`).get(params)).count);
    const rows = await db.prepare(`SELECT * FROM (${union}) library ORDER BY ${sortSql},kind,origin_node_id NULLS FIRST,id LIMIT @limit OFFSET @offset`).all(params);
    const items = rows.map(row => row.kind === 'local' ? localItem(row, apiPrefix) : remoteItem(row, apiPrefix));
    sendJson(res, 200, { items, total, limit, offset, has_more:offset + items.length < total, scope });
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (req.method !== 'GET') return false;
    if (url.pathname === '/api/favorites') {
      await favorites(res, url, user, apiPrefix);
      return true;
    }
    if (url.pathname === '/api/library') {
      await library(res, url, user, apiPrefix);
      return true;
    }
    return false;
  }

  return { handle };
}
