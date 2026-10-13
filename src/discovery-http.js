import crypto from 'node:crypto';

const LOCAL_ID = /^[0-9a-f-]{36}$/;

export function createDiscoveryHttpController({ catalog, db, decodeReference, readJson, sendJson, now = () => new Date() }) {
  async function recommendations(res, user, apiPrefix) {
    const tracks = (await db.prepare(`SELECT tracks.id,tracks.title,tracks.artist,tracks.album,tracks.filename,tracks.mime_type,
      tracks.size_bytes,tracks.duration_seconds,tracks.created_at,tracks.cover_key,tracks.genre,tracks.year,tracks.track_number,tracks.disc_number,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') AS replay_gain_db,
      EXISTS(SELECT 1 FROM track_files ready192 WHERE ready192.track_id=tracks.id AND ready192.variant='aac_192' AND ready192.status='ready') AS aac_192_ready,
      EXISTS(SELECT 1 FROM track_files ready96 WHERE ready96.track_id=tracks.id AND ready96.variant='aac_96' AND ready96.status='ready') AS aac_96_ready,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.track_id=tracks.id AND track_likes.user_id=@user_id) liked,
      COALESCE(play_history.play_count,0) play_count,play_history.last_played_at
      FROM tracks LEFT JOIN play_history ON play_history.track_id=tracks.id AND play_history.user_id=@user_id`).all({ user_id:user.id })).map(track => ({
        ...track,
        liked:Boolean(track.liked),
        play_count:Number(track.play_count || 0),
        cover_url:track.cover_key ? `${apiPrefix}/tracks/${track.id}/cover` : null,
        cover_key:undefined,
      }));
    const current = now(), day = current.toISOString().slice(0, 10);
    const randomScore = track => parseInt(crypto.createHash('sha256').update(`${day}:${user.id}:${track.id}`).digest('hex').slice(0, 12), 16);
    const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    const byRecent = (a, b) => new Date(b.last_played_at) - new Date(a.last_played_at);
    const played = tracks.filter(track => track.last_played_at).sort(byRecent);
    const liked = tracks.filter(track => track.liked), affinity = new Map();
    for (const track of tracks) {
      const weight = (track.liked ? 5 : 0) + Math.min(track.play_count, 10);
      if (!weight) continue;
      if (track.artist && track.artist !== 'Неизвестный исполнитель') affinity.set(`artist:${track.artist}`, (affinity.get(`artist:${track.artist}`) || 0) + weight);
      if (track.genre) affinity.set(`genre:${track.genre}`, (affinity.get(`genre:${track.genre}`) || 0) + weight);
    }
    const recentCutoff = current.getTime() - 14 * 86400000;
    const discover = [...tracks]
      .filter(track => !track.last_played_at || new Date(track.last_played_at).getTime() < recentCutoff)
      .map(track => ({ track, score:(affinity.get(`artist:${track.artist}`) || 0) * 3 + (affinity.get(`genre:${track.genre}`) || 0) * 2 + randomScore(track) / 1e14 }))
      .sort((a, b) => b.score - a.score).map(item => item.track).slice(0, 20);
    const sections = [];
    if (played.length) sections.push({ id:'continue', title:'Продолжить слушать', subtitle:'То, что звучало недавно', items:played.slice(0, 12) });
    if (liked.length) sections.push({ id:'favorites', title:'Любимые вперемешку', subtitle:'Ежедневный микс из ваших сердечек', items:[...liked].sort((a, b) => randomScore(a) - randomScore(b)).slice(0, 20) });
    if (discover.length) sections.push({ id:'discover', title:'Давно не звучало', subtitle:'Знакомые исполнители и жанры без недавних повторов', items:discover });
    const newest = [...tracks].sort(byNewest).slice(0, 16);
    if (newest.length) sections.push({ id:'newest', title:'Недавно добавлено', subtitle:'Новое в общей семейной библиотеке', items:newest });
    const topGenres = [...affinity.entries()].filter(([key]) => key.startsWith('genre:')).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => key.slice(6));
    for (const genre of topGenres) {
      const items = tracks.filter(track => track.genre === genre).sort((a, b) => randomScore(a) - randomScore(b)).slice(0, 12);
      if (items.length >= 2) sections.push({ id:`genre-${genre}`, title:genre, subtitle:'Подборка по любимому жанру', items });
    }
    sendJson(res, 200, { generated_for:day, sections });
  }

  async function resolve(req, res, user, apiPrefix) {
    const body = await readJson(req, 1024 * 1024);
    const requested = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))].slice(0, 10000) : [];
    const ids = requested.filter(id => LOCAL_ID.test(id));
    const remoteRefs = requested.filter(id => id.startsWith('remote:')).map(id => id.slice(7));
    if (!ids.length && !remoteRefs.length) {
      sendJson(res, 200, { items:[] });
      return;
    }
    const rows = ids.length ? await db.prepare(`SELECT id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,created_at,cover_key,genre,year,track_number,disc_number,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') AS replay_gain_db,
      EXISTS(SELECT 1 FROM track_files ready192 WHERE ready192.track_id=tracks.id AND ready192.variant='aac_192' AND ready192.status='ready') AS aac_192_ready,
      EXISTS(SELECT 1 FROM track_files ready96 WHERE ready96.track_id=tracks.id AND ready96.variant='aac_96' AND ready96.status='ready') AS aac_96_ready,
      EXISTS(SELECT 1 FROM track_likes WHERE track_likes.track_id=tracks.id AND track_likes.user_id=@user_id) liked FROM tracks WHERE id = ANY(@ids)`).all({ user_id:user.id, ids }) : [];
    const byId = new Map(rows.map(track => [track.id, {
      ...track,
      cover_url:track.cover_key ? `${apiPrefix}/tracks/${track.id}/cover` : null,
      cover_key:undefined,
    }]));
    for (const ref of remoteRefs) {
      try {
        const decoded = decodeReference(ref);
        const track = await db.prepare(`SELECT remote.*,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,replica.status replica_status,replica.received_bytes replica_received_bytes,replica.size_bytes replica_size_bytes,(EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) liked FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id WHERE remote.origin_node_id=@node_id AND remote.object_id=@object_id`).get({ user_id:user.id, node_id:decoded.nodeId, object_id:decoded.objectId });
        if (!track) continue;
        const availability = track.revoked_at || track.peer_status === 'revoked' ? 'revoked' : track.sync_error || !track.last_synced_at || new Date(track.last_synced_at) < new Date(Date.now() - 10 * 60 * 1000) ? 'offline' : 'online';
        byId.set(`remote:${ref}`, { ...track, id:`remote:${ref}`, remote:true, remote_ref:ref, availability, stream_available:track.replica_status === 'ready' || availability === 'online', stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(ref)}&quality=original`, cover_url:null });
      } catch {}
    }
    sendJson(res, 200, { items:requested.map(id => byId.get(id)).filter(Boolean) });
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (url.pathname === '/api/tracks' && req.method === 'GET') {
      sendJson(res, 200, await catalog.listTracks({ searchParams:url.searchParams, userId:user.id, responsePrefix:apiPrefix }));
      return true;
    }
    if (url.pathname === '/api/recommendations' && req.method === 'GET') {
      await recommendations(res, user, apiPrefix);
      return true;
    }
    if (url.pathname === '/api/tracks/resolve' && req.method === 'POST') {
      await resolve(req, res, user, apiPrefix);
      return true;
    }
    if (url.pathname === '/api/catalog' && req.method === 'GET') {
      sendJson(res, 200, await catalog.listCollections({ searchParams:url.searchParams, responsePrefix:apiPrefix }));
      return true;
    }
    return false;
  }

  return { handle };
}
