const topLevelRoutes = new Map([
  ['liked', 'liked'],
  ['recommendations', 'recommendations'],
  ['search', 'search'],
  ['tracks', 'tracks'],
  ['history', 'history'],
  ['artists', 'artists'],
  ['albums', 'albums'],
  ['playlists', 'playlists'],
  ['upload', 'upload'],
  ['settings', 'settings'],
]);
const settingsSections = new Set(['statistics', 'users', 'registration', 'federation', 'recognition', 'reports', 'duplicates', 'password']);

const positiveInteger = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

export function parseWebRoute(pathname = '/', search = '') {
  const parts = String(pathname).split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  const query = new URLSearchParams(search);
  const route = {
    view: 'liked', artistId: 0, albumId: 0, playlistId: '',
    query: query.get('q') || '',
    scope: ['all', 'local', 'remote'].includes(query.get('scope')) ? query.get('scope') : '',
    sort: ['newest', 'oldest', 'title', 'artist', 'album', 'year'].includes(query.get('sort')) ? query.get('sort') : '',
    page: Math.max(0, positiveInteger(query.get('page')) - 1),
    pageSize: [50, 100, 200].includes(Number(query.get('page_size'))) ? Number(query.get('page_size')) : 0,
    node: query.get('node') || '', settingsSection: '', unknownPath: '',
    kind: ['tracks', 'albums', 'artists'].includes(query.get('kind')) ? query.get('kind') : 'tracks',
    canonical: true,
  };
  if (!parts.length) { route.canonical = false; return route; }
  if (parts.length === 1 && topLevelRoutes.has(parts[0])) { route.view = topLevelRoutes.get(parts[0]); return route; }
  if (parts.length === 2 && parts[0] === 'settings' && parts[1] === 'recognition-queue') { route.view = 'recognition'; return route; }
  if (parts.length === 2 && parts[0] === 'settings' && settingsSections.has(parts[1])) { route.view = 'settings'; route.settingsSection = parts[1]; return route; }
  if (parts.length === 2 && parts[0] === 'albums' && positiveInteger(parts[1])) { route.view = 'collection'; route.albumId = positiveInteger(parts[1]); return route; }
  if (parts.length === 2 && parts[0] === 'artists' && positiveInteger(parts[1])) { route.view = 'collection'; route.artistId = positiveInteger(parts[1]); return route; }
  if (parts.length === 2 && parts[0] === 'playlists' && /^[0-9a-f-]{8,}$/i.test(parts[1])) { route.view = 'playlist'; route.playlistId = parts[1]; return route; }
  route.notFound = true; route.view = 'not-found'; route.unknownPath = String(pathname);
  return route;
}

export function webRouteForState(state) {
  let pathname = '/liked';
  if (state.view === 'collection' && state.albumId) pathname = `/albums/${state.albumId}`;
  else if (state.view === 'collection' && state.artistId) pathname = `/artists/${state.artistId}`;
  else if (state.view === 'playlist' && state.playlistId) pathname = `/playlists/${encodeURIComponent(state.playlistId)}`;
  else if (state.view === 'settings' && state.settingsSection) pathname = `/settings/${state.settingsSection}`;
  else if (state.view === 'recognition') pathname = '/settings/recognition-queue';
  else if (state.view === 'not-found' && state.unknownPath) pathname = state.unknownPath;
  else if ([...topLevelRoutes.values()].includes(state.view)) pathname = `/${state.view}`;

  const query = new URLSearchParams();
  if (state.query) query.set('q', state.query);
  if (state.view === 'tracks' && state.scope && state.scope !== 'all') query.set('scope', state.scope);
  if (['tracks', 'liked'].includes(state.view) && state.sort && state.sort !== 'newest') query.set('sort', state.sort);
  if (Number(state.page) > 0) query.set('page', String(Number(state.page) + 1));
  if (state.pageSize && Number(state.pageSize) !== 50) query.set('page_size', String(state.pageSize));
  if (state.view === 'search' && state.node) query.set('node', state.node);
  if (state.view === 'search' && state.kind && state.kind !== 'tracks') query.set('kind', state.kind);
  const suffix = query.toString();
  return pathname + (suffix ? `?${suffix}` : '');
}
