export async function savePlaybackState({ db, userId, trackId, remoteTrackRef, decodedRemote, position, queue, shuffle, repeatMode, queueSource }) {
  return db.transaction(async tx => {
    if (trackId && !await tx.prepare('SELECT id FROM tracks WHERE id=? FOR KEY SHARE').get(trackId)) return false;
    if (decodedRemote && !await tx.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=? FOR KEY SHARE').get(decodedRemote.nodeId, decodedRemote.objectId)) return false;
    await tx.prepare(`INSERT INTO playback_state(user_id,track_id,remote_track_ref,position_seconds,queue_json,shuffle,repeat_mode,queue_source) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET track_id=excluded.track_id,remote_track_ref=excluded.remote_track_ref,position_seconds=excluded.position_seconds,queue_json=excluded.queue_json,
      shuffle=excluded.shuffle,repeat_mode=excluded.repeat_mode,queue_source=excluded.queue_source,updated_at=CURRENT_TIMESTAMP`)
      .run(userId, trackId, remoteTrackRef, position, JSON.stringify(queue), shuffle ? 1 : 0, repeatMode, queueSource);
    return true;
  });
}
