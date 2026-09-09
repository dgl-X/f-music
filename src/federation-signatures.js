import crypto from 'node:crypto';

const COMPONENTS = ['@method', '@target-uri', 'content-digest', 'x-family-music-node', 'x-family-music-nonce'];
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function federationContentDigest(body = Buffer.alloc(0)) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return `sha-256=:${crypto.createHash('sha256').update(value).digest('base64')}:`;
}

function signatureParameters({ created, keyId }) {
  return `(${COMPONENTS.map(value => `"${value}"`).join(' ')});created=${created};keyid="${keyId}";alg="ed25519"`;
}

export function federationSignatureBase({ method, targetUri, digest, nodeId, nonce, parameters }) {
  return [
    `"@method": ${String(method).toUpperCase()}`,
    `"@target-uri": ${targetUri}`,
    `"content-digest": ${digest}`,
    `"x-family-music-node": ${nodeId}`,
    `"x-family-music-nonce": ${nonce}`,
    `"@signature-params": ${parameters}`,
  ].join('\n');
}

export function signFederationRequest({ method, targetUri, body = Buffer.alloc(0), nodeId, privateKeyPem, keyId = nodeId, created = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(18).toString('base64url') }) {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('Некорректный nonce федерации');
  const digest = federationContentDigest(body), parameters = signatureParameters({ created, keyId });
  const base = federationSignatureBase({ method, targetUri, digest, nodeId, nonce, parameters });
  const signature = crypto.sign(null, Buffer.from(base), privateKeyPem).toString('base64');
  return {
    'content-digest': digest,
    'x-family-music-node': nodeId,
    'x-family-music-nonce': nonce,
    'signature-input': `sig1=${parameters}`,
    signature: `sig1=:${signature}:`,
  };
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
}

export async function verifyFederationRequest({ method, targetUri, body = Buffer.alloc(0), headers, publicKey, expectedNodeId, now = Math.floor(Date.now() / 1000), maxClockSkewSeconds = 300, consumeNonce }) {
  const digest = String(header(headers, 'content-digest') || '');
  const nodeId = String(header(headers, 'x-family-music-node') || '');
  const nonce = String(header(headers, 'x-family-music-nonce') || '');
  const input = String(header(headers, 'signature-input') || '');
  const signatureHeader = String(header(headers, 'signature') || '');
  if (expectedNodeId && nodeId !== expectedNodeId) throw Object.assign(new Error('Подпись принадлежит другой ноде'), { code: 'node_mismatch' });
  if (!NONCE_PATTERN.test(nonce)) throw Object.assign(new Error('Некорректный nonce'), { code: 'invalid_nonce' });
  const inputMatch = /^sig1=(\("@method" "@target-uri" "content-digest" "x-family-music-node" "x-family-music-nonce"\);created=(\d+);keyid="([^"\\]+)";alg="ed25519")$/.exec(input);
  const signatureMatch = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(signatureHeader);
  if (!inputMatch || !signatureMatch) throw Object.assign(new Error('Некорректный формат подписи'), { code: 'invalid_signature' });
  const created = Number(inputMatch[2]);
  if (!Number.isSafeInteger(created) || Math.abs(now - created) > maxClockSkewSeconds) throw Object.assign(new Error('Время подписи вне допустимого окна'), { code: 'clock_skew' });
  const actualDigest = federationContentDigest(body);
  if (digest.length !== actualDigest.length || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(actualDigest))) throw Object.assign(new Error('Content-Digest не совпадает'), { code: 'digest_mismatch' });
  const base = federationSignatureBase({ method, targetUri, digest, nodeId, nonce, parameters: inputMatch[1] });
  const key = typeof publicKey === 'string' && !publicKey.includes('BEGIN')
    ? crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' }) : publicKey;
  if (!crypto.verify(null, Buffer.from(base), key, Buffer.from(signatureMatch[1], 'base64'))) throw Object.assign(new Error('Подпись не прошла проверку'), { code: 'invalid_signature' });
  if (consumeNonce && !await consumeNonce(nodeId, nonce, created)) throw Object.assign(new Error('Nonce уже использован'), { code: 'replay_detected' });
  return { nodeId, nonce, created, keyId: inputMatch[3] };
}

function pairingConfirmationText({ invitationId, requesterNodeId, issuerNodeId, challenge }) {
  return `family-music-pairing-v1\n${invitationId}\n${requesterNodeId}\n${issuerNodeId}\n${challenge}`;
}

export function signPairingConfirmation(values, privateKeyPem) {
  return crypto.sign(null, Buffer.from(pairingConfirmationText(values)), privateKeyPem).toString('base64url');
}

export function verifyPairingConfirmation(values, signature, publicKey) {
  const key = typeof publicKey === 'string' && !publicKey.includes('BEGIN')
    ? crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' }) : publicKey;
  return crypto.verify(null, Buffer.from(pairingConfirmationText(values)), key, Buffer.from(signature, 'base64url'));
}

function federationResponseText(nodeId, digest) {
  return `family-music-response-v1\n${nodeId}\n${digest}`;
}

export function signFederationResponse(body, nodeId, privateKeyPem) {
  const digest = federationContentDigest(body);
  return { 'content-digest': digest, 'x-family-music-node': nodeId, 'x-family-music-response-signature': crypto.sign(null, Buffer.from(federationResponseText(nodeId, digest)), privateKeyPem).toString('base64url') };
}

export function verifyFederationResponse(body, headers, expectedNodeId, publicKey) {
  const digest = String(header(headers, 'content-digest') || ''), actual = federationContentDigest(body);
  const nodeId = String(header(headers, 'x-family-music-node') || ''), signature = String(header(headers, 'x-family-music-response-signature') || '');
  if (nodeId !== expectedNodeId || digest !== actual) return false;
  const key = typeof publicKey === 'string' && !publicKey.includes('BEGIN') ? crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' }) : publicKey;
  return crypto.verify(null, Buffer.from(federationResponseText(nodeId, digest)), key, Buffer.from(signature, 'base64url'));
}
