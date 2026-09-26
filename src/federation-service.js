const SETTING_KEYS = [
  'federation_enabled',
  'federation_endpoints',
  'federation_export_policy',
  'federation_export_albums',
  'federation_export_collections',
];

export function parseFederationSettingList(value, { coerce = true } = {}) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return (coerce ? parsed.map(String) : parsed.filter(item => typeof item === 'string')).slice(0, 1000);
  } catch {
    return [];
  }
}

export function validateFederationEndpoints(value) {
  if (!Array.isArray(value) || value.length > 8) {
    throw Object.assign(new Error('Допускается не более 8 адресов ноды'), { status: 400 });
  }
  return value.map((item, index) => {
    const address = String(item?.url || '').trim();
    let parsed;
    try {
      parsed = new URL(address);
    } catch {
      throw Object.assign(new Error(`Некорректный адрес №${index + 1}`), { status: 400 });
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw Object.assign(new Error('Адрес ноды должен использовать HTTPS и не содержать логин'), { status: 400 });
    }
    const scope = item?.scope === 'private' ? 'private' : 'public';
    const priority = Number.isInteger(item?.priority)
      ? Math.max(0, Math.min(1000, item.priority))
      : index * 10;
    return { url: parsed.toString().replace(/\/$/, ''), scope, priority };
  });
}

export function externalFederationRequestUri(req, url) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}${url.pathname}${url.search}`;
}

export function decodeFederationInvitationCode(input) {
  const value = String(input || '').trim();
  const prefix = 'fm-invite-v1:';
  if (!value.startsWith(prefix) || value.length > 16384) return null;
  try {
    return JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function encodeFederationInvitationCode(invitation) {
  return `fm-invite-v1:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`;
}

export function createFederationService({ db }) {
  async function settings() {
    const placeholders = SETTING_KEYS.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT key,value FROM app_settings WHERE key IN (${placeholders})`).all(...SETTING_KEYS);
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    let endpoints = [];
    try { endpoints = JSON.parse(values.federation_endpoints || '[]'); } catch {}
    const policy = ['all', 'albums', 'collections'].includes(values.federation_export_policy)
      ? values.federation_export_policy
      : 'none';
    return {
      enabled: values.federation_enabled === 'true',
      endpoints: Array.isArray(endpoints) ? endpoints : [],
      export_policy: policy,
      selected_albums: parseFederationSettingList(values.federation_export_albums, { coerce: false }),
      selected_collections: parseFederationSettingList(values.federation_export_collections, { coerce: false }),
    };
  }

  async function exportSettings(peerNodeId = null) {
    const global = await settings();
    let selected = global;
    if (peerNodeId) {
      const rule = await db.prepare('SELECT policy,selected_albums_json,selected_collections_json FROM federation_peer_export_rules WHERE peer_node_id=?').get(peerNodeId);
      if (rule && rule.policy !== 'inherit') {
        selected = {
          ...global,
          export_policy: rule.policy,
          selected_albums: parseFederationSettingList(rule.selected_albums_json),
          selected_collections: parseFederationSettingList(rule.selected_collections_json),
        };
      }
    }
    let selectedTrackIds = [];
    if (selected.export_policy === 'collections' && selected.selected_collections.length) {
      selectedTrackIds = (await db.prepare('SELECT DISTINCT track_id FROM federation_export_collection_tracks WHERE collection_id=ANY(?::text[])').all(selected.selected_collections)).map(row => row.track_id);
    }
    return { ...selected, selected_track_ids: selectedTrackIds };
  }

  async function consumeNonce(nodeId, nonce, created) {
    await db.prepare('DELETE FROM federation_nonces WHERE expires_at<CURRENT_TIMESTAMP').run();
    const expires = new Date((created + 600) * 1000).toISOString();
    const result = await db.prepare('INSERT INTO federation_nonces(node_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce').run(nodeId, nonce, expires);
    return result.changes === 1;
  }

  async function trustedPeer(nodeId) {
    return db.prepare("SELECT node_id,public_key FROM federation_peers WHERE node_id=? AND status IN ('compatible','limited') AND revoked_at IS NULL").get(nodeId);
  }

  async function invitation(invitationId, secretHash) {
    return db.prepare(`SELECT * FROM federation_invitations
      WHERE id=? AND secret_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP`).get(invitationId, secretHash);
  }

  async function consumeInvitation(invitationId) {
    const result = await db.prepare('UPDATE federation_invitations SET used_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL RETURNING id').run(invitationId);
    return result.changes === 1;
  }

  async function savePeer({ nodeId, label = '', publicKey, endpoint, status, protocolMinor = 0, capabilities = {} }) {
    await db.prepare(`INSERT INTO federation_peers(node_id,label,public_key,endpoint,status,protocol_major,protocol_minor,capabilities_json,last_seen_at)
      VALUES(?,?,?,?,?,1,?,?,CURRENT_TIMESTAMP) ON CONFLICT(node_id) DO UPDATE SET
      public_key=excluded.public_key,endpoint=excluded.endpoint,status=excluded.status,
      protocol_minor=excluded.protocol_minor,capabilities_json=excluded.capabilities_json,
      updated_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,revoked_at=NULL`)
      .run(nodeId, String(label).slice(0, 120), publicKey, endpoint, status, Math.max(0, protocolMinor), JSON.stringify(capabilities));
  }

  async function listInvitations() {
    return db.prepare(`SELECT id,endpoint,expires_at,used_at,revoked_at,created_at,
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'used'
      WHEN expires_at<=CURRENT_TIMESTAMP THEN 'expired' ELSE 'active' END AS status
      FROM federation_invitations ORDER BY created_at DESC LIMIT 50`).all();
  }

  async function createInvitation({ id, secretHash, endpoint, expiresAt, createdBy }) {
    await db.prepare('INSERT INTO federation_invitations(id,secret_hash,endpoint,expires_at,created_by) VALUES(?,?,?,?,?)')
      .run(id, secretHash, endpoint, expiresAt, createdBy);
  }

  async function revokeInvitation(invitationId) {
    const result = await db.prepare('UPDATE federation_invitations SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL AND revoked_at IS NULL RETURNING id').run(invitationId);
    return result.changes === 1;
  }

  async function listPeers() {
    const items = await db.prepare(`SELECT federation_peers.node_id,federation_peers.label,federation_peers.endpoint,federation_peers.status,federation_peers.protocol_major,federation_peers.protocol_minor,federation_peers.capabilities_json,federation_peers.created_at,federation_peers.updated_at,federation_peers.last_seen_at,federation_peers.revoked_at,
      federation_peers.catalog_cursor,federation_peers.last_synced_at,federation_peers.next_sync_at,federation_peers.sync_failures,federation_peers.sync_error,federation_peers.remote_latest_revision,federation_peers.last_notified_revision,federation_peers.notify_failures,federation_peers.notify_error,
      federation_peers.stream_failures,federation_peers.stream_unavailable_until,federation_peers.last_stream_error,federation_peers.last_stream_success_at,
      federation_peers.next_health_at,federation_peers.health_failures,federation_peers.last_health_at,
      (SELECT count(*) FROM federation_remote_tracks WHERE origin_node_id=federation_peers.node_id) AS remote_tracks,
      rule.policy AS export_policy,rule.selected_albums_json,rule.selected_collections_json
      FROM federation_peers LEFT JOIN federation_peer_export_rules rule ON rule.peer_node_id=federation_peers.node_id ORDER BY federation_peers.created_at DESC`).all();
    return items.map(item => ({
      ...item,
      export_policy: item.export_policy || 'inherit',
      selected_albums: parseFederationSettingList(item.selected_albums_json),
      selected_collections: parseFederationSettingList(item.selected_collections_json),
      selected_albums_json: undefined,
      selected_collections_json: undefined,
      capabilities: JSON.parse(item.capabilities_json || '{}'),
      capabilities_json: undefined,
    }));
  }

  async function revokePeer(nodeId) {
    const result = await db.prepare("UPDATE federation_peers SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE node_id=? AND revoked_at IS NULL RETURNING node_id").run(nodeId);
    return result.changes === 1;
  }

  return {
    settings, exportSettings, consumeNonce, trustedPeer, invitation,
    consumeInvitation, savePeer, listInvitations, createInvitation,
    revokeInvitation, listPeers, revokePeer,
  };
}
