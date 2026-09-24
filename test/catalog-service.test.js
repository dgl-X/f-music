import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogService, parseArtistLookupRequest, parseCollectionListRequest, parseTrackListRequest } from '../src/catalog-service.js';

test('track catalog parameters have stable bounds and safe sorting', () => {
  const normal = parseTrackListRequest(new URLSearchParams('limit=9999&offset=-3&sort=unknown&seed=a!b&q=%20song%20'));
  assert.equal(normal.limit, 200);
  assert.equal(normal.offset, 0);
  assert.equal(normal.order, 'created_at DESC');
  assert.equal(normal.seed, 'ab');
  assert.equal(normal.query, 'song');

  const queue = parseTrackListRequest(new URLSearchParams('queue=1&limit=999999&sort=random'));
  assert.equal(queue.limit, 10000);
  assert.equal(queue.order, 'md5(id || @seed)');
});

test('track catalog keeps pagination envelope and user-scoped filters', async () => {
  const calls = [];
  const db = { prepare(sql) { return {
    async get(params) { calls.push({ type: 'get', sql, params }); return { count: 3 }; },
    async all(params) { calls.push({ type: 'all', sql, params }); return [{ id: 'track-1', cover_key: 'covers/1.jpg' }]; },
  }; } };
  const catalog = createCatalogService({ db, apiPrefix: '/api/v1' });
  const result = await catalog.listTracks({
    userId: 7,
    searchParams: new URLSearchParams('liked=1&playlist_id=list-1&limit=1&offset=1&sort=title'),
  });

  assert.deepEqual(result, {
    items: [{ id: 'track-1', cover_key: undefined, cover_url: '/api/v1/tracks/track-1/cover' }],
    total: 3, offset: 1, limit: 1, has_more: true,
  });
  assert.match(calls[0].sql, /track_likes likes_filter/);
  assert.match(calls[0].sql, /playlist_tracks/);
  assert.equal(calls[0].params.current_user, 7);
  assert.match(calls[1].sql, /ORDER BY title COLLATE NOCASE ASC,id/);
});

test('legacy album and artist pair resolves to the album card id', async () => {
  const calls = [];
  const db = { prepare(sql) { return {
    async get(...params) {
      calls.push({ type: 'get', sql, params });
      if (sql.startsWith('SELECT id FROM albums')) return { id: 42 };
      return { count: 0 };
    },
    async all(params) { calls.push({ type: 'all', sql, params }); return []; },
  }; } };
  const catalog = createCatalogService({ db, apiPrefix: '/api' });
  await catalog.listTracks({ userId: 1, searchParams: new URLSearchParams('album=Album&artist=Artist') });
  const count = calls.find(call => call.sql.startsWith('SELECT count'));
  assert.match(count.sql, /album_id = @album_id/);
  assert.equal(count.params[0].album_id, 42);
  assert.doesNotMatch(count.sql, /artists\.name=@artist/);
});

test('album and artist catalog parameters keep their public limits', () => {
  assert.deepEqual(parseCollectionListRequest(new URLSearchParams('view=albums&limit=999&offset=-5&q=%20rock%20')), {
    view: 'albums', query: 'rock', limit: 200, offset: 0,
  });
  assert.deepEqual(parseCollectionListRequest(new URLSearchParams('view=invalid')), {
    view: '', query: '', limit: 50, offset: 0,
  });
  assert.deepEqual(parseArtistLookupRequest(new URLSearchParams('limit=900&q=%20artist%20')), {
    query: 'artist', limit: 500,
  });
});

test('album catalog returns a stable pagination envelope and search filter', async () => {
  const calls = [];
  const db = { prepare(sql) { return {
    async get(params) { calls.push({ type: 'get', sql, params }); return { count: 4 }; },
    async all(params) { calls.push({ type: 'all', sql, params }); return [{ id: 8, name: 'Album' }]; },
  }; } };
  const catalog = createCatalogService({ db, apiPrefix: '/api' });
  const result = await catalog.listCollections({ searchParams: new URLSearchParams('view=albums&q=band&limit=1&offset=2') });
  assert.deepEqual(result, { items: [{ id: 8, name: 'Album' }], total: 4, offset: 2, limit: 1, has_more: true });
  assert.match(calls[0].sql, /albums\.name ILIKE @query OR albums\.artist ILIKE @query/);
  assert.match(calls[1].sql, /LIMIT @limit OFFSET @offset/);
  assert.equal(calls[1].params.query, '%band%');
});

test('artist catalog removes storage keys and builds public image URLs', async () => {
  const db = { prepare(sql) { return {
    async get() { return { count: 1 }; },
    async all() { return [{ id: 3, name: 'Artist', image_key: 'artists/3.jpg' }]; },
  }; } };
  const catalog = createCatalogService({ db, apiPrefix: '/api/v1' });
  const result = await catalog.listCollections({ searchParams: new URLSearchParams('view=artists') });
  assert.deepEqual(result.items, [{ id: 3, name: 'Artist', image_url: '/api/v1/artists/3/image' }]);
  assert.equal(result.total, 1);
});

test('artist lookup remains bounded and searchable for track editor suggestions', async () => {
  let captured;
  const db = { prepare(sql) { return { async all(params) { captured = { sql, params }; return [{ id: 1, name: 'A' }]; } }; } };
  const catalog = createCatalogService({ db, apiPrefix: '/api' });
  assert.deepEqual(await catalog.lookupArtists({ searchParams: new URLSearchParams('q=A&limit=20') }), { items: [{ id: 1, name: 'A' }] });
  assert.match(captured.sql, /WHERE name ILIKE @query/);
  assert.deepEqual(captured.params, { limit: 20, query: '%A%' });
});
