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

export function parseCollectionListRequest(searchParams) {
  const view = String(searchParams.get('view') || '');
  return {
    view: view === 'artists' || view === 'albums' ? view : '',
    query: String(searchParams.get('q') || '').trim().slice(0, 120),
    limit: Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 50)),
    offset: Math.max(0, Number(searchParams.get('offset')) || 0),
  };
}

export function parseArtistLookupRequest(searchParams) {
  return {
    query: String(searchParams.get('q') || '').trim().slice(0, 120),
    limit: Math.min(500, Math.max(1, Number(searchParams.get('limit')) || 100)),
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

  async function listCollections({ searchParams }) {
    const request = parseCollectionListRequest(searchParams);
    const pageSql = request.view ? ' LIMIT @limit OFFSET @offset' : '';
    const params = { limit: request.limit, offset: request.offset, query: `%${request.query}%` };
    const artistWhere = request.query ? 'AND artists.name ILIKE @query' : '';
    const artistTotal = request.view === 'artists'
      ? Number((await db.prepare(`SELECT count(*) count FROM artists WHERE EXISTS(SELECT 1 FROM track_artists WHERE track_artists.artist_id=artists.id) ${artistWhere}`).get(params)).count)
      : 0;
    const artists = request.view === 'albums' ? [] : await db.prepare(`SELECT artists.id,artists.name,artists.bio,artists.image_key,count(*) AS track_count,
      min(tracks.id) FILTER (WHERE tracks.cover_key IS NOT NULL) AS cover_track_id,
      count(*) FILTER (WHERE track_artists.role='featured') AS featured_count
      FROM artists JOIN track_artists ON track_artists.artist_id=artists.id JOIN tracks ON tracks.id=track_artists.track_id WHERE TRUE ${artistWhere}
      GROUP BY artists.id,artists.name,artists.bio,artists.image_key ORDER BY artists.name COLLATE NOCASE${request.view === 'artists' ? pageSql : ''}`).all(params);
    for (const artist of artists) {
      artist.image_url = artist.image_key ? `${apiPrefix}/artists/${artist.id}/image` : null;
      delete artist.image_key;
    }
    if (request.view === 'artists') return {
      items: artists, total: artistTotal, offset: request.offset, limit: request.limit,
      has_more: request.offset + artists.length < artistTotal,
    };

    const albumFilter = request.query ? 'AND (albums.name ILIKE @query OR albums.artist ILIKE @query)' : '';
    const albumTotal = request.view === 'albums'
      ? Number((await db.prepare(`SELECT count(*) count FROM albums WHERE EXISTS(SELECT 1 FROM tracks WHERE tracks.album_id=albums.id) ${albumFilter}`).get(params)).count)
      : 0;
    const albums = await db.prepare(`SELECT albums.id,albums.name,albums.artist,albums.bio,COALESCE(albums.year,max(tracks.year)) AS year,
      count(tracks.id) AS track_count,
      min(tracks.id) FILTER (WHERE tracks.cover_key IS NOT NULL) AS cover_track_id,
      CASE WHEN albums.image_key IS NOT NULL THEN '${apiPrefix}/albums/'||albums.id||'/image' ELSE NULL END AS image_url
      FROM albums JOIN tracks ON tracks.album_id=albums.id WHERE TRUE ${albumFilter}
      GROUP BY albums.id ORDER BY albums.name COLLATE NOCASE${request.view === 'albums' ? pageSql : ''}`).all(params);
    if (request.view === 'albums') return {
      items: albums, total: albumTotal, offset: request.offset, limit: request.limit,
      has_more: request.offset + albums.length < albumTotal,
    };
    return { artists, albums };
  }

  async function lookupArtists({ searchParams }) {
    const request = parseArtistLookupRequest(searchParams);
    const params = { limit: request.limit };
    const where = request.query ? 'WHERE name ILIKE @query' : '';
    if (request.query) params.query = `%${request.query}%`;
    const items = await db.prepare(`SELECT id,name FROM artists ${where} ORDER BY name COLLATE NOCASE LIMIT @limit`).all(params);
    return { items };
  }

  async function canEditAlbum({ userId, isAdmin, albumId }) {
    if (isAdmin) return true;
    const ownership = await db.prepare(`SELECT count(*) total,
      count(*) FILTER(WHERE owner_id=?) mine FROM tracks WHERE album_id=?`).get(userId, albumId);
    return Number(ownership.total) > 0 && Number(ownership.mine) === Number(ownership.total);
  }

  async function getArtist({ artistId, responsePrefix = apiPrefix }) {
    const artist = await db.prepare(`SELECT artists.id,artists.name,artists.bio,artists.image_key,count(DISTINCT track_artists.track_id) track_count,
      count(DISTINCT track_artists.track_id) FILTER(WHERE track_artists.role='featured') featured_count,
      count(DISTINCT NULLIF(tracks.album,'')) album_count,COALESCE(sum(history.plays),0) play_count
      FROM artists JOIN track_artists ON track_artists.artist_id=artists.id JOIN tracks ON tracks.id=track_artists.track_id
      LEFT JOIN (SELECT track_id,sum(play_count) plays FROM play_history GROUP BY track_id) history ON history.track_id=tracks.id
      WHERE artists.id=? GROUP BY artists.id`).get(artistId);
    if (!artist) return null;
    const albums = await db.prepare(`SELECT albums.id,albums.name,count(*) AS track_count,albums.year,
      min(tracks.id) FILTER(WHERE tracks.cover_key IS NOT NULL) AS cover_track_id
      FROM albums JOIN tracks ON tracks.album_id=albums.id JOIN track_artists ON track_artists.track_id=tracks.id
      WHERE track_artists.artist_id=? GROUP BY albums.id ORDER BY albums.name COLLATE NOCASE`).all(artist.id);
    return {
      ...artist,
      image_url: artist.image_key ? `${responsePrefix}/artists/${artist.id}/image` : null,
      image_key: undefined,
      albums,
    };
  }

  async function getAlbum({ albumId, userId, isAdmin, responsePrefix = apiPrefix }) {
    const album = await db.prepare('SELECT id,name,artist,bio,image_key,year FROM albums WHERE id=?').get(albumId);
    if (!album) return null;
    return {
      ...album,
      image_url: album.image_key ? `${responsePrefix}/albums/${album.id}/image` : null,
      image_key: undefined,
      can_edit: await canEditAlbum({ userId, isAdmin, albumId: album.id }),
    };
  }

  return { listTracks, listCollections, lookupArtists, getArtist, getAlbum, canEditAlbum };
}
