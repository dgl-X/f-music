export function groupArtistTracks(items = []) {
  const primary = [];
  const featured = [];
  for (const item of items) {
    if (item?.artist_role === 'featured') featured.push(item);
    else primary.push(item);
  }
  return { items: [...primary, ...featured], primaryCount: primary.length, featuredCount: featured.length };
}

export function groupArtistAlbums(items = []) {
  const albums = [];
  const appearances = [];
  for (const item of items) {
    if (item?.artist_role === 'featured') appearances.push(item);
    else albums.push(item);
  }
  return { albums, appearances };
}

export function artistAlbumMeta(album = {}) {
  const total = Number(album.track_count) || 0;
  const credited = Number(album.credited_track_count) || 0;
  const word = total % 10 === 1 && total % 100 !== 11 ? 'трек' : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 10 || total % 100 >= 20) ? 'трека' : 'треков';
  const parts = [];
  if (Number(album.year) > 0) parts.push(String(album.year));
  parts.push(`${total} ${word}`);
  if (album.artist_role === 'featured' && credited > 0 && credited < total) parts.push(`${credited} с участием`);
  return parts.join(' · ');
}
