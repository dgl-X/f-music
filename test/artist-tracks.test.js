import assert from 'node:assert/strict';
import test from 'node:test';
import { artistAlbumMeta, groupArtistAlbums, groupArtistTracks } from '../public/artist-tracks.js';

test('artist tracks keep popularity order inside primary and featured sections', () => {
  const source = [
    { id: 'featured-1', artist_role: 'featured' },
    { id: 'primary-1', artist_role: 'primary' },
    { id: 'featured-2', artist_role: 'featured' },
    { id: 'legacy' },
  ];
  const grouped = groupArtistTracks(source);
  assert.deepEqual(grouped.items.map(item => item.id), ['primary-1', 'legacy', 'featured-1', 'featured-2']);
  assert.equal(grouped.primaryCount, 2);
  assert.equal(grouped.featuredCount, 2);
  assert.deepEqual(source.map(item => item.id), ['featured-1', 'primary-1', 'featured-2', 'legacy']);
});

test('artist albums separate own releases from appearances', () => {
  const grouped = groupArtistAlbums([
    { id: 1, artist_role: 'featured' },
    { id: 2, artist_role: 'primary' },
    { id: 3 },
  ]);
  assert.deepEqual(grouped.albums.map(item => item.id), [2, 3]);
  assert.deepEqual(grouped.appearances.map(item => item.id), [1]);
});

test('appearance metadata distinguishes album size from credited tracks', () => {
  assert.equal(artistAlbumMeta({ year: 2024, track_count: 15, credited_track_count: 1, artist_role: 'featured' }), '2024 · 15 треков · 1 с участием');
  assert.equal(artistAlbumMeta({ track_count: 22, credited_track_count: 22, artist_role: 'primary' }), '22 трека');
});
