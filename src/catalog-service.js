const TRACK_ORDERS = Object.freeze({
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  title: 'title COLLATE NOCASE ASC',
  artist: 'artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC',
  album: 'album COLLATE NOCASE ASC, disc_number ASC NULLS LAST, track_number ASC NULLS LAST, title COLLATE NOCASE ASC',
  year: 'year DESC, album COLLATE NOCASE ASC',
  random: 'md5(id || @seed)',
});

export function parseTrackListRequest(searchParams) {
  const queue = searchParams.get('queue') === '1';
  const sort = String(searchParams.get('sort') || 'newest');
  return {
    query: String(searchParams.get('q') ?? '').trim().slice(0, 120),
    artist: String(searchParams.get('artist') ?? '').trim().slice(0, 240),
    album: String(searchParams.get('album') ?? '').trim().slice(0, 240),
    albumId: Number(searchParams.get('album_id')),
    liked: searchParams.get('liked') === '1',
    playlistId: String(searchParams.get('playlist_id') ?? ''),
    sort,
    order: TRACK_ORDERS[sort] || TRACK_ORDERS.newest,
    queue,
    limit: Math.min(queue ? 10000 : 200, Math.max(1, Number(searchParams.get('limit')) || 100)),
    offset: Math.max(0, Number(searchParams.get('offset')) || 0),
    seed: String(searchParams.get('seed') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'family-music',
  };
}

export function createCatalogService({ db, apiPrefix }) {
  async function listTracks({ searchParams, userId }) {
    const request = parseTrackListRequest(searchParams);
    const where = [];
    const params = { current_user: userId, limit: request.limit, offset: request.offset, seed: request.seed };
    if (request.query) {
      where.push('(title ILIKE @query OR artist ILIKE @query OR album ILIKE @query OR genre ILIKE @query)');
      params.query = `%${request.query}%`;
    }
    const legacyAlbum = request.album && request.artist && !request.albumId
      ? await db.prepare('SELECT id FROM albums WHERE lower(name)=lower(?) AND lower(artist)=lower(?)').get(request.album, request.artist)
      : null;
    if (legacyAlbum) {
      where.push('album_id = @album_id');
      params.album_id = Number(legacyAlbum.id);
    } else if (Number.isSafeInteger(request.albumId) && request.albumId > 0) {
      where.push('album_id = @album_id');
      params.album_id = request.albumId;
    } else {
      if (request.artist) {
        where.push(`EXISTS(SELECT 1 FROM track_artists JOIN artists ON artists.id=track_artists.artist_id
          WHERE track_artists.track_id=tracks.id AND artists.name=@artist COLLATE NOCASE)`);
        params.artist = request.artist;
      }
      if (request.album) {
        where.push('album = @album COLLATE NOCASE');
        params.album = request.album;
      }
    }
    if (request.liked) where.push('EXISTS(SELECT 1 FROM track_likes likes_filter WHERE likes_filter.track_id=tracks.id AND likes_filter.user_id=@current_user)');
    if (request.playlistId) {
      where.push('id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id=@playlist_id)');
      params.playlist_id = request.playlistId;
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await db.prepare(`SELECT count(*) count FROM tracks ${filter}`).get(params)).count);
    const sql = `SELECT id, title, artist, album, album_id, filename, mime_type, size_bytes, duration_seconds, created_at,
      cover_key, genre, year, track_number, disc_number,
      (SELECT recommended_gain_db FROM loudness_jobs WHERE loudness_jobs.track_id=tracks.id AND status='ready') AS replay_gain_db,
      EXISTS(SELECT 1 FROM track_files ready192 WHERE ready192.track_id=tracks.id AND ready192.variant='aac_192' AND ready192.status='ready') AS aac_192_ready,
      EXISTS(SELECT 1 FROM track_files ready96 WHERE ready96.track_id=tracks.id AND ready96.variant='aac_96' AND ready96.status='ready') AS aac_96_ready,
      EXISTS(SELECT 1 FROM track_likes likes_state WHERE likes_state.track_id=tracks.id AND likes_state.user_id=@current_user) AS liked
      FROM tracks ${filter} ORDER BY ${request.order},id LIMIT @limit OFFSET @offset`;
    const items = (await db.prepare(sql).all(params)).map(track => ({
      ...track,
      cover_url: track.cover_key ? `${apiPrefix}/tracks/${track.id}/cover` : null,
      cover_key: undefined,
    }));
    return { items, total, offset: request.offset, limit: request.limit, has_more: request.offset + items.length < total };
  }

  return { listTracks };
}
