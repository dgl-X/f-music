import { describePublicKeyValue, publicNodeDescriptor } from './federation-identity.js';
import { probeFederationEndpoint, postFederationJson } from './federation-endpoints.js';
import { negotiateFederation } from './federation-protocol.js';
import {
  signFederationRequest,
  signPairingConfirmation,
  verifyFederationRequest,
  verifyPairingConfirmation,
} from './federation-signatures.js';

function pairingError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

export function createFederationPairingService({
  federation,
  softwareVersion,
  probeEndpoint = probeFederationEndpoint,
  postJson = postFederationJson,
  randomToken,
  tokenHash,
}) {
  async function accept({ body, bytes, method, targetUri, headers, settings, identity }) {
    const invitation = await federation.invitation(body.invitation_id, tokenHash(String(body.secret || '')));
    if (!invitation) throw pairingError('Приглашение недействительно или истекло', 'invalid_invitation', 403);

    const remote = body.node || {};
    const described = describePublicKeyValue(String(remote.public_key?.value || ''));
    if (described.nodeId !== remote.node_id) throw pairingError('node_id не соответствует публичному ключу', 'node_id_mismatch', 400);
    if (remote.node_id === identity.node_id) throw pairingError('Нельзя подключить ноду саму к себе', 'self_pairing', 409);

    await verifyFederationRequest({
      method,
      targetUri,
      body: bytes,
      headers,
      publicKey: remote.public_key.value,
      expectedNodeId: remote.node_id,
      consumeNonce: federation.consumeNonce,
    });

    const remoteEndpoint = remote.endpoints?.find(item => item.scope === 'public')?.url;
    if (!remoteEndpoint) throw pairingError('У подключаемой ноды нет публичного endpoint', 'endpoint_required', 400);
    const negotiation = negotiateFederation(remote, ['pairing.v1']);
    const protocolMinor = negotiation.minor ?? 0;
    if (!await federation.consumeInvitation(invitation.id)) throw pairingError('Приглашение уже использовано', 'invitation_used', 409);

    await federation.savePeer({
      nodeId: remote.node_id,
      label: remote.label,
      publicKey: remote.public_key.value,
      endpoint: remoteEndpoint,
      status: negotiation.status,
      protocolMinor,
      capabilities: remote.capabilities || {},
    });
    const node = publicNodeDescriptor(identity, { softwareVersion, endpoints: settings.endpoints });
    const confirmationValues = {
      invitationId: invitation.id,
      requesterNodeId: remote.node_id,
      issuerNodeId: identity.node_id,
      challenge: String(body.challenge || ''),
    };
    return {
      node,
      status: negotiation.status,
      confirmation: signPairingConfirmation(confirmationValues, identity.private_key_pem),
    };
  }

  async function connect({ invitation, identity, settings }) {
    const described = describePublicKeyValue(String(invitation.public_key || ''));
    if (described.nodeId !== invitation.issuer_node_id) throw pairingError('node_id приглашения не соответствует ключу', 'invitation_node_mismatch', 400);
    if (invitation.issuer_node_id === identity.node_id) throw pairingError('Нельзя принять приглашение собственной ноды', 'self_pairing', 409);

    const probe = await probeEndpoint(invitation.endpoint, 'public');
    if (probe.node_id !== invitation.issuer_node_id) throw pairingError('Endpoint отвечает от имени другой ноды', 'endpoint_node_mismatch', 409);

    const challenge = randomToken();
    const node = publicNodeDescriptor(identity, { softwareVersion, endpoints: settings.endpoints });
    const payload = JSON.stringify({ invitation_id: invitation.invitation_id, secret: invitation.secret, challenge, node });
    const targetUri = `${String(invitation.endpoint).replace(/\/$/, '')}/federation/v1/pairing/accept`;
    const headers = signFederationRequest({ method: 'POST', targetUri, body: payload, nodeId: identity.node_id, privateKeyPem: identity.private_key_pem });
    const response = await postJson(invitation.endpoint, '/federation/v1/pairing/accept', payload, headers);

    const issuer = response.node || {};
    const issuerDescription = describePublicKeyValue(String(issuer.public_key?.value || ''));
    if (issuer.node_id !== invitation.issuer_node_id || issuerDescription.nodeId !== invitation.issuer_node_id || issuer.public_key.value !== invitation.public_key) {
      throw pairingError('Ответ подписан неожиданной identity', 'unexpected_identity', 409);
    }
    const confirmationValues = {
      invitationId: invitation.invitation_id,
      requesterNodeId: identity.node_id,
      issuerNodeId: issuer.node_id,
      challenge,
    };
    if (!verifyPairingConfirmation(confirmationValues, String(response.confirmation || ''), issuer.public_key.value)) {
      throw pairingError('Не удалось проверить подтверждение pairing', 'invalid_pairing_confirmation', 409);
    }

    const negotiation = negotiateFederation(issuer, ['pairing.v1']);
    await federation.savePeer({
      nodeId: issuer.node_id,
      publicKey: issuer.public_key.value,
      endpoint: invitation.endpoint,
      status: negotiation.status,
      protocolMinor: negotiation.minor ?? 0,
      capabilities: issuer.capabilities || {},
    });
    return { ok: true, node_id: issuer.node_id, endpoint: invitation.endpoint, status: negotiation.status };
  }

  return { accept, connect };
}
