// Read-only baseline. Legacy play_history cannot reconstruct listening minutes
// or the number of plays within a period: only the latest date is retained.
const numbers = row => Object.fromEntries(Object.entries(row || {}).map(([key,value]) => [key,Number(value) || 0]));

export function createListeningStatistics({ db, now = () => new Date() }) {
  async function personal(userId) {
    const params = { user_id:userId };
    const [summary,tracks,artists,albums] = await Promise.all([
      db.prepare(`SELECT COALESCE(sum(play_count),0) AS recorded_plays,
        count(*) FILTER (WHERE play_count>0) AS unique_tracks,
        count(*) FILTER (WHERE play_count>0 AND last_played_at>=CURRENT_TIMESTAMP-INTERVAL '7 days') AS recent_tracks_7d,
        count(*) FILTER (WHERE play_count>0 AND last_played_at>=CURRENT_TIMESTAMP-INTERVAL '30 days') AS recent_tracks_30d,
        (SELECT count(*) FROM track_likes WHERE user_id=@user_id) AS local_likes,
        (SELECT count(*) FROM federation_remote_likes WHERE user_id=@user_id) AS remote_likes,
        (SELECT count(*) FROM playlists WHERE owner_id=@user_id) AS playlists
        FROM play_history WHERE user_id=@user_id`).get(params),
      db.prepare(`SELECT t.id,t.title,t.artist,t.album,h.play_count AS recorded_plays
        FROM play_history h JOIN tracks t ON t.id=h.track_id
        WHERE h.user_id=@user_id AND h.play_count>0
        ORDER BY h.play_count DESC,t.title,t.id LIMIT 10`).all(params),
      db.prepare(`SELECT a.id,a.name,COALESCE(sum(h.play_count),0) AS recorded_plays
        FROM play_history h JOIN track_artists credit ON credit.track_id=h.track_id
        JOIN artists a ON a.id=credit.artist_id WHERE h.user_id=@user_id AND h.play_count>0
        GROUP BY a.id,a.name ORDER BY recorded_plays DESC,a.name,a.id LIMIT 10`).all(params),
      db.prepare(`SELECT a.id,a.name,a.artist,COALESCE(sum(h.play_count),0) AS recorded_plays
        FROM play_history h JOIN tracks t ON t.id=h.track_id JOIN albums a ON a.id=t.album_id
        WHERE h.user_id=@user_id AND h.play_count>0
        GROUP BY a.id,a.name,a.artist ORDER BY recorded_plays DESC,a.name,a.id LIMIT 10`).all(params),
    ]);
    const total=numbers(summary);
    return { generated_at:now().toISOString(), period:'all_time', basis:'legacy_play_history',
      scope:'local_history', listening_seconds:null, period_plays_available:false,
      summary:{...total,likes:total.local_likes+total.remote_likes},
      top_tracks:tracks.map(row=>({...row,recorded_plays:Number(row.recorded_plays)})),
      top_artists:artists.map(row=>({...row,recorded_plays:Number(row.recorded_plays)})),
      top_albums:albums.map(row=>({...row,recorded_plays:Number(row.recorded_plays)})) };
  }

  async function administrative() {
    const [activity,collections,library,sessions] = await Promise.all([
      db.prepare(`SELECT COALESCE(sum(play_count),0) AS recorded_plays,
        count(DISTINCT user_id) FILTER (WHERE play_count>0) AS listeners,
        count(DISTINCT user_id) FILTER (WHERE play_count>0 AND last_played_at>=CURRENT_TIMESTAMP-INTERVAL '7 days') AS listeners_7d,
        count(DISTINCT user_id) FILTER (WHERE play_count>0 AND last_played_at>=CURRENT_TIMESTAMP-INTERVAL '30 days') AS listeners_30d
        FROM play_history`).get(),
      db.prepare(`SELECT (SELECT count(*) FROM users) AS accounts,
        (SELECT count(*) FROM playlists) AS playlists,
        (SELECT count(*) FROM track_likes) AS local_likes,
        (SELECT count(*) FROM federation_remote_likes) AS remote_likes`).get(),
      db.prepare(`SELECT count(*) AS tracks,COALESCE(sum(size_bytes),0) AS original_bytes,
        count(*) FILTER (WHERE created_at>=CURRENT_TIMESTAMP-INTERVAL '7 days') AS added_tracks_7d,
        count(*) FILTER (WHERE created_at>=CURRENT_TIMESTAMP-INTERVAL '30 days') AS added_tracks_30d
        FROM tracks`).get(),
      // Sessions, not devices or plays. Deliberately return no account/client names or IPs.
      db.prepare(`SELECT count(*) AS active_sessions,
        count(DISTINCT user_id) AS accounts_with_sessions,
        count(*) FILTER (WHERE last_seen_at>=CURRENT_TIMESTAMP-INTERVAL '24 hours') AS sessions_seen_24h
        FROM sessions WHERE expires_at>CURRENT_TIMESTAMP`).get(),
    ]);
    return { generated_at:now().toISOString(),period:'all_time',basis:'legacy_play_history',
      scope:'local_history',listening_seconds:null,period_plays_available:false,
      activity:numbers(activity),collections:numbers(collections),library:numbers(library),sessions:numbers(sessions) };
  }
  return { personal,administrative };
}
