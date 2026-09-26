export const FEDERATION_QUEUE_ONLINE_SQL = `peer.sync_error IS NULL
  AND peer.last_synced_at IS NOT NULL
  AND peer.last_synced_at>=CURRENT_TIMESTAMP-INTERVAL '10 minutes'
  AND (peer.stream_unavailable_until IS NULL OR peer.stream_unavailable_until<=CURRENT_TIMESTAMP)`;

export function federationCircuitDelay(failures) {
  if (failures < 2) return 0;
  return Math.min(900, 30 * 2 ** Math.min(5, failures - 2));
}

export function federationHealthDelay(failures) {
  return Math.min(900, 30 * 2 ** Math.min(5, Math.max(0, failures - 1)));
}

export function federationPeerAvailability(peer, now = Date.now()) {
  if (!peer || peer.revoked_at || peer.status === 'revoked') return 'revoked';
  const synced = peer.last_synced_at ? new Date(peer.last_synced_at).getTime() : 0;
  const blockedUntil = peer.stream_unavailable_until ? new Date(peer.stream_unavailable_until).getTime() : 0;
  return peer.sync_error || synced < now - 10 * 60 * 1000 || blockedUntil > now ? 'offline' : 'online';
}

export function createFederationAvailabilityService({ db }) {
  let healthBusy = false;

  async function recordSuccess(nodeId) {
    await db.prepare(`UPDATE federation_peers SET stream_failures=0,stream_unavailable_until=NULL,
      last_stream_error=NULL,last_stream_success_at=CURRENT_TIMESTAMP WHERE node_id=?`).run(nodeId);
  }

  async function recordFailure(nodeId, error) {
    const peer = await db.prepare('SELECT stream_failures FROM federation_peers WHERE node_id=?').get(nodeId);
    if (!peer) return 0;
    const failures = Number(peer.stream_failures || 0) + 1;
    const delay = federationCircuitDelay(failures);
    await db.prepare(`UPDATE federation_peers SET stream_failures=?,
      stream_unavailable_until=CASE WHEN ?>0 THEN CURRENT_TIMESTAMP+(? * INTERVAL '1 second') ELSE stream_unavailable_until END,
      last_stream_error=?,next_health_at=LEAST(next_health_at,CURRENT_TIMESTAMP) WHERE node_id=?`).run(failures, delay, delay, String(error || 'stream_failed').slice(0, 1000), nodeId);
    return delay;
  }

  async function check(probe) {
    if (healthBusy) return false;
    healthBusy = true;
    try {
      const peers = await db.prepare(`SELECT * FROM federation_peers WHERE status IN ('compatible','limited') AND revoked_at IS NULL
        AND next_health_at<=CURRENT_TIMESTAMP AND (sync_error IS NOT NULL OR last_synced_at IS NULL
          OR last_synced_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes' OR stream_unavailable_until>CURRENT_TIMESTAMP)
        ORDER BY next_health_at LIMIT 4`).all();
      for (const peer of peers) try {
        const result = await probe(peer.endpoint, 'public', { timeoutMs:5000 });
        if (result.node_id !== peer.node_id) throw new Error('Endpoint ответил identity другой ноды');
        await db.prepare(`UPDATE federation_peers SET health_failures=0,last_health_at=CURRENT_TIMESTAMP,
          next_health_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes',stream_failures=0,stream_unavailable_until=NULL,
          last_stream_error=NULL,last_stream_success_at=CURRENT_TIMESTAMP,next_sync_at=LEAST(next_sync_at,CURRENT_TIMESTAMP)
          WHERE node_id=?`).run(peer.node_id);
      } catch (error) {
        const failures = Number(peer.health_failures || 0) + 1;
        await db.prepare(`UPDATE federation_peers SET health_failures=?,last_health_at=CURRENT_TIMESTAMP,
          next_health_at=CURRENT_TIMESTAMP+(? * INTERVAL '1 second'),last_stream_error=? WHERE node_id=?`)
          .run(failures, federationHealthDelay(failures), String(error.message || error).slice(0, 1000), peer.node_id);
      }
      return true;
    } finally { healthBusy = false; }
  }

  return { recordSuccess, recordFailure, check };
}
