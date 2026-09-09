#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openFederationStream } from '../src/federation-endpoints.js';
import { loadFederationIdentity } from '../src/federation-identity.js';
import { signFederationRequest } from '../src/federation-signatures.js';

function readEnv(file) {
  const env = { ...process.env };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

const envFile = process.argv[2] || '/opt/family-music/.env';
const config = loadConfig(readEnv(envFile));
const db = await openDatabase(config.databaseUrl);
const identity = loadFederationIdentity(config.storageDir);
const held = [];

async function request(peer, objectId, range = '') {
  const query = new URLSearchParams({ quality: 'original' });
  if (range) query.set('range', range);
  const remotePath = `/federation/v1/tracks/${encodeURIComponent(objectId)}/stream?${query}`;
  const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
  const headers = signFederationRequest({
    method: 'GET', targetUri, nodeId: identity.node_id, privateKeyPem: identity.private_key_pem,
  });
  return openFederationStream(peer.endpoint, remotePath, headers);
}

try {
  if (!identity) throw new Error('Identity федерации не создана');
  const target = await db.prepare(`SELECT peer.node_id,peer.endpoint,remote.object_id
    FROM federation_peers peer JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id
    WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ORDER BY remote.duration_seconds DESC NULLS LAST LIMIT 1`).get();
  if (!target) throw new Error('Нет подключённой ноды с удалёнными треками');

  const burst = await Promise.all(Array.from({ length: 5 }, () => request(target, target.object_id)));
  for (const stream of burst) {
    if (stream.response.statusCode === 200 || stream.response.statusCode === 206) {
      stream.response.pause();
      held.push(stream);
    } else stream.response.resume();
  }
  const statuses = burst.map(item => item.response.statusCode).sort((a, b) => a - b);
  if (statuses.filter(status => status === 429).length !== 1 || held.length !== 4) {
    throw new Error(`Ожидались четыре потока и один HTTP 429, получено: ${statuses.join(', ')}`);
  }

  for (const stream of held.splice(0)) {
    stream.response.destroy();
    stream.request.destroy();
  }
  await new Promise(resolve => setTimeout(resolve, 300));

  const partial = await request(target, target.object_id, 'bytes=0-1023');
  const chunks = [];
  for await (const chunk of partial.response) chunks.push(chunk);
  const bytes = Buffer.concat(chunks).length;
  if (partial.response.statusCode !== 206 || bytes !== 1024) {
    throw new Error(`Partial stream: HTTP ${partial.response.statusCode}, ${bytes} байт`);
  }

  const invalid = await request(target, target.object_id, 'bytes=999999999999-1000000000000');
  invalid.response.resume();
  await new Promise(resolve => invalid.response.once('end', resolve));
  if (invalid.response.statusCode !== 416) throw new Error(`Ожидался HTTP 416, получен ${invalid.response.statusCode}`);

  const afterFailure = await request(target, target.object_id, 'bytes=0-0');
  afterFailure.response.resume();
  await new Promise(resolve => afterFailure.response.once('end', resolve));
  if (afterFailure.response.statusCode !== 206) throw new Error('Слот не освободился после ошибочного Range');

  console.log(JSON.stringify({ ok: true, concurrency: statuses, partial_bytes: bytes, invalid_range: 416, recovery: 206 }));
} finally {
  for (const stream of held) {
    stream.response.destroy();
    stream.request.destroy();
  }
  await db.close();
}
