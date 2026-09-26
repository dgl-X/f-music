import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFederationPairingService } from '../src/federation-pairing.js';
import { ensureFederationIdentity } from '../src/federation-identity.js';
import { randomToken, tokenHash } from '../src/security.js';

function memoryFederation(invitation) {
  const peers = [];
  let consumed = false;
  return {
    peers,
    async invitation(id, hash) {
      return !consumed && id === invitation.id && hash === invitation.secret_hash ? invitation : null;
    },
    async consumeInvitation(id) {
      if (consumed || id !== invitation.id) return false;
      consumed = true;
      return true;
    },
    async consumeNonce() { return true; },
    async savePeer(peer) { peers.push(peer); },
  };
}

test('network pairing verifies both identities and stores trust on both nodes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-pairing-'));
  try {
    const requester = ensureFederationIdentity(path.join(root, 'requester'));
    const issuer = ensureFederationIdentity(path.join(root, 'issuer'));
    const endpoint = 'https://issuer.example.test';
    const secret = 'one-time-secret';
    const invitationRow = { id: 'invite-1', secret_hash: tokenHash(secret) };
    const issuerFederation = memoryFederation(invitationRow);
    const requesterFederation = memoryFederation({ id: 'unused', secret_hash: 'unused' });
    const issuerPairing = createFederationPairingService({
      federation: issuerFederation,
      softwareVersion: 'test',
      randomToken,
      tokenHash,
    });
    const requesterPairing = createFederationPairingService({
      federation: requesterFederation,
      softwareVersion: 'test',
      randomToken: () => 'fixed-challenge',
      tokenHash,
      probeEndpoint: async () => ({ node_id: issuer.node_id }),
      postJson: async (_endpoint, route, payload, headers) => {
        assert.equal(route, '/federation/v1/pairing/accept');
        return issuerPairing.accept({
          body: JSON.parse(payload),
          bytes: Buffer.from(payload),
          method: 'POST',
          targetUri: `${endpoint}${route}`,
          headers,
          settings: { endpoints: [{ url: endpoint, scope: 'public' }] },
          identity: issuer,
        });
      },
    });
    const invitation = {
      version: 1,
      invitation_id: invitationRow.id,
      issuer_node_id: issuer.node_id,
      endpoint,
      public_key: issuer.public_key,
      secret,
      expires_at: '2030-01-01T00:00:00.000Z',
    };
    const result = await requesterPairing.connect({
      invitation,
      identity: requester,
      settings: { endpoints: [{ url: 'https://requester.example.test', scope: 'public' }] },
    });
    assert.equal(result.node_id, issuer.node_id);
    assert.equal(result.status, 'compatible');
    assert.equal(issuerFederation.peers[0].nodeId, requester.node_id);
    assert.equal(requesterFederation.peers[0].nodeId, issuer.node_id);
    assert.equal(await issuerFederation.consumeInvitation(invitationRow.id), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('network pairing rejects connecting a node to itself before network I/O', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-self-pairing-'));
  try {
    const identity = ensureFederationIdentity(root);
    let probed = false;
    const pairing = createFederationPairingService({
      federation: memoryFederation({ id: 'unused', secret_hash: 'unused' }),
      softwareVersion: 'test', randomToken, tokenHash,
      probeEndpoint: async () => { probed = true; },
    });
    await assert.rejects(() => pairing.connect({
      invitation: { issuer_node_id:identity.node_id, public_key:identity.public_key, endpoint:'https://self.example.test' },
      identity,
      settings: { endpoints: [] },
    }), error => error.code === 'self_pairing' && error.status === 409);
    assert.equal(probed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
