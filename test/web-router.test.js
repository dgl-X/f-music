import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebRoute, webRouteForState } from '../public/web-router.js';

test('web router restores tabs and pagination from a direct URL', () => {
  assert.deepEqual(parseWebRoute('/tracks', '?q=Guf&scope=local&sort=album&page=3&page_size=100'), {
    view:'tracks', artistId:0, albumId:0, playlistId:'', query:'Guf', scope:'local', sort:'album',
    page:2, pageSize:100, node:'', kind:'tracks', settingsSection:'', unknownPath:'', canonical:true,
  });
});

test('web router uses stable ids for album, artist and playlist cards', () => {
  assert.equal(parseWebRoute('/albums/42').albumId, 42);
  assert.equal(parseWebRoute('/artists/7').artistId, 7);
  assert.equal(parseWebRoute('/playlists/710a322d-4477-43ad-b9bb-37769e9e074b').playlistId, '710a322d-4477-43ad-b9bb-37769e9e074b');
});

test('web router serializes canonical collection and list URLs', () => {
  assert.equal(webRouteForState({view:'collection',albumId:42}), '/albums/42');
  assert.equal(webRouteForState({view:'tracks',query:'город дорог',scope:'remote',sort:'title',page:1,pageSize:50}), '/tracks?q=%D0%B3%D0%BE%D1%80%D0%BE%D0%B4+%D0%B4%D0%BE%D1%80%D0%BE%D0%B3&scope=remote&sort=title&page=2');
});

test('root remains compatible and unknown paths are distinguishable', () => {
  assert.equal(parseWebRoute('/').view, 'liked');
  assert.equal(parseWebRoute('/').canonical, false);
  assert.equal(parseWebRoute('/does-not-exist').notFound, true);
});

test('settings sections and internal 404 survive a refresh', () => {
  assert.equal(parseWebRoute('/settings/federation').settingsSection, 'federation');
  assert.equal(webRouteForState({view:'settings',settingsSection:'reports'}), '/settings/reports');
  const missing=parseWebRoute('/missing/page');
  assert.equal(missing.view,'not-found');
  assert.equal(webRouteForState({view:missing.view,unknownPath:missing.unknownPath}),'/missing/page');
});
