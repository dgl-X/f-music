export function createFederationCatalogEvents({ db, federationTrackVisible }) {
  async function appendVisibilityEvents(tx, previousSettings, nextSettings, trackIds = null) {
    const params = Array.isArray(trackIds) && trackIds.length ? trackIds : null;
    const tracks = params
      ? await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks WHERE id=ANY(?::text[]) ORDER BY created_at,id`).all(params)
      : await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks ORDER BY created_at,id`).all();
    const insertEvent = tx.prepare('INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES(?,?,?::jsonb)');
    for (const track of tracks) {
      const wasVisible = federationTrackVisible(track, previousSettings), isVisible = federationTrackVisible(track, nextSettings);
      if (wasVisible === isVisible) continue;
      const payload = isVisible
        ? { title:track.title, artist:track.artist, album:track.album, genre:track.genre, year:track.year, duration_seconds:track.duration_seconds, track_number:track.track_number, disc_number:track.disc_number, cover_available:Boolean(track.cover_key), created_at:track.created_at, policy_event:true }
        : { album:track.album, artist:track.artist, policy_event:true };
      await insertEvent.run(isVisible ? 'track.upsert.v1' : 'track.delete.v1', track.id, JSON.stringify(payload));
    }
  }

  async function appendTrackRefreshEvents(tx, trackIds) {
    const ids = [...new Set((trackIds || []).map(String))];
    if (!ids.length) return;
    const tracks = await tx.prepare(`SELECT id,title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key,created_at FROM tracks WHERE id=ANY(?::text[])`).all(ids);
    const insertEvent = tx.prepare("INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES('track.upsert.v1',?,?::jsonb)");
    for (const track of tracks) await insertEvent.run(track.id, JSON.stringify({ title:track.title, artist:track.artist, album:track.album, genre:track.genre, year:track.year, duration_seconds:track.duration_seconds, track_number:track.track_number, disc_number:track.disc_number, cover_available:Boolean(track.cover_key), created_at:track.created_at, policy_event:true }));
  }

  return { appendVisibilityEvents, appendTrackRefreshEvents };
}
