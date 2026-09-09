import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FEDERATION_CAPABILITIES, FEDERATION_PROTOCOL_MAJOR, FEDERATION_PROTOCOL_MINOR } from './federation-protocol.js';

const IDENTITY_VERSION = 1;

function publicDer(publicKeyPem) {
  return crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
}

export function describePublicKey(publicKeyPem) {
  const der = publicDer(publicKeyPem);
  const digest = crypto.createHash('sha256').update(der).digest();
  const hex = digest.toString('hex').toUpperCase();
  return {
    nodeId: `fm:${digest.toString('base64url')}`,
    fingerprint: hex.match(/.{1,4}/g).join(' '),
    value: der.toString('base64url'),
  };
}

export function describePublicKeyValue(value) {
  const key = crypto.createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' });
  return describePublicKey(key.export({ type: 'spki', format: 'pem' }));
}

export function loadFederationIdentity(storageDir) {
  const file = path.join(storageDir, 'federation', 'identity.json');
  if (!fs.existsSync(file)) return null;
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (identity.version !== IDENTITY_VERSION || !identity.private_key_pem || !identity.public_key_pem) throw new Error('Некорректная identity федерации');
  const description = describePublicKey(identity.public_key_pem);
  if (identity.node_id !== description.nodeId) throw new Error('Identity федерации повреждена');
  return { ...identity, fingerprint: description.fingerprint, public_key: description.value };
}

export function ensureFederationIdentity(storageDir) {
  const existing = loadFederationIdentity(storageDir);
  if (existing) return existing;
  const directory = path.join(storageDir, 'federation');
  const file = path.join(directory, 'identity.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const description = describePublicKey(publicKeyPem);
  const identity = {
    version: IDENTITY_VERSION,
    node_id: description.nodeId,
    created_at: new Date().toISOString(),
    algorithm: 'ed25519',
    public_key_pem: publicKeyPem,
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  fs.chmodSync(file, 0o600);
  return loadFederationIdentity(storageDir);
}

export function publicNodeDescriptor(identity, { softwareVersion, endpoints = [] } = {}) {
  return {
    node_id: identity.node_id,
    software_version: softwareVersion || '0.0.0',
    protocols: { [FEDERATION_PROTOCOL_MAJOR]: { minor: FEDERATION_PROTOCOL_MINOR } },
    capabilities: FEDERATION_CAPABILITIES,
    public_key: { key_id: identity.node_id, algorithm: 'ed25519', value: identity.public_key },
    endpoints,
  };
}
