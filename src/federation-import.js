import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openFederationStream } from './federation-endpoints.js';
import { signFederationRequest } from './federation-signatures.js';

export function federationImportRetryDelay(attempts) {
  return Math.min(3600, 10 * 2 ** Math.min(8, Math.max(0, Number(attempts) - 1)));
}

export function federationReplicaPaths(storageDir, nodeId, objectId) {
  const shard = crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 16);
  return { temporaryPath:path.join(storageDir, 'federation', 'replicas', shard, `.${objectId}.part`) };
}

export const federationSourceId = (nodeId, objectId) => `${nodeId}\n${objectId}`;

export function createFederationImportService({ db, storageDir, uploadDir, originalDir, loadIdentity, extractCover, sha256File, openStream = openFederationStream, logger = console, startOperation = null }) {
  let busy = false;

  async function downloadCover(nodeId, objectId, trackId) {
    const remote = await db.prepare('SELECT cover_available FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(nodeId, objectId);
    if (!remote?.cover_available) return null;
    const peer = await db.prepare("SELECT * FROM federation_peers WHERE node_id=? AND revoked_at IS NULL AND status IN ('compatible','limited')").get(nodeId);
    const identity = loadIdentity();
    if (!peer || !identity) return null;
    const remotePath = `/federation/v1/tracks/${encodeURIComponent(objectId)}/cover`;
    const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
    const headers = signFederationRequest({ method:'GET', targetUri, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
    const upstream = await openStream(peer.endpoint, remotePath, headers, { timeoutMs:15000 });
    const status = upstream.response.statusCode || 502;
    if (status !== 200) { upstream.response.resume(); return null; }
    const declared = Number(upstream.response.headers['content-length']);
    if (Number.isFinite(declared) && (declared < 1 || declared > 12 * 1024 * 1024)) {
      upstream.response.destroy();
      throw new Error('Некорректный размер федеративной обложки');
    }
    const temporary = path.join(uploadDir, `federation-cover-${crypto.randomUUID()}.image`);
    let received = 0;
    try {
      const output = fs.createWriteStream(temporary, { flags:'wx', mode:0o640 });
      try {
        for await (const chunk of upstream.response) {
          received += chunk.length;
          if (received > 12 * 1024 * 1024) throw new Error('Федеративная обложка превышает 12 МиБ');
          if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
        }
        await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
      } catch (error) { output.destroy(); throw error; }
      if (!received) return null;
      return await extractCover(temporary, trackId);
    } finally { fs.rmSync(temporary, { force:true }); }
  }

  async function complete(job, paths, mimeType, total, sha256) {
    const remote = await db.prepare('SELECT * FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(job.origin_node_id, job.object_id);
    const likers = await db.prepare('SELECT user_id FROM federation_remote_likes WHERE origin_node_id=? AND object_id=? ORDER BY created_at').all(job.origin_node_id, job.object_id);
    if (!remote || !likers.length) {
      fs.rmSync(paths.temporaryPath, { force:true });
      await db.prepare("UPDATE federation_remote_replicas SET status='removed',received_bytes=0,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(job.origin_node_id, job.object_id);
      return;
    }
    const sourceId = federationSourceId(job.origin_node_id, job.object_id);
    const duplicate = await db.prepare('SELECT id FROM tracks WHERE sha256=?').get(sha256);
    if (duplicate) {
      fs.rmSync(paths.temporaryPath, { force:true });
      const duplicateTrack = await db.prepare('SELECT cover_key FROM tracks WHERE id=?').get(duplicate.id);
      let importedCover = null;
      if (!duplicateTrack?.cover_key) try { importedCover = await downloadCover(job.origin_node_id, job.object_id, duplicate.id); }
      catch (error) { logger.error(`Не удалось импортировать обложку ${job.object_id}:`, error.message || error); }
      await db.transaction(async tx => {
        if (importedCover) await tx.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=? AND cover_key IS NULL').run(importedCover, duplicate.id);
        for (const liker of likers) await tx.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(liker.user_id, duplicate.id);
        await tx.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('federation',?,?) ON CONFLICT(source,source_id) DO UPDATE SET track_id=excluded.track_id").run(sourceId, duplicate.id);
        await tx.prepare('DELETE FROM federation_remote_likes WHERE origin_node_id=? AND object_id=?').run(job.origin_node_id, job.object_id);
        await tx.prepare("UPDATE federation_remote_replicas SET status='imported',local_track_id=?,storage_key=NULL,mime_type=?,size_bytes=?,received_bytes=?,sha256=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(duplicate.id, mimeType, total, total, sha256, job.origin_node_id, job.object_id);
      });
      return;
    }
    const trackId = crypto.randomUUID();
    const shard = trackId.slice(0, 2);
    const destinationDir = path.join(originalDir, shard);
    const destination = path.join(destinationDir, trackId);
    fs.mkdirSync(destinationDir, { recursive:true, mode:0o750 });
    let coverKey = await extractCover(paths.temporaryPath, trackId);
    if (!coverKey) try { coverKey = await downloadCover(job.origin_node_id, job.object_id, trackId); }
    catch (error) { logger.error(`Не удалось импортировать обложку ${job.object_id}:`, error.message || error); }
    fs.renameSync(paths.temporaryPath, destination);
    try {
      await db.transaction(async tx => {
        await tx.prepare(`INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key,sha256,cover_key,cover_checked,genre,year,track_number,disc_number)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(trackId, likers[0].user_id, remote.title || 'Без названия', remote.artist || 'Неизвестный исполнитель', remote.album || '', `${remote.artist || 'Исполнитель'} - ${remote.title || trackId}`, mimeType, total, remote.duration_seconds, path.posix.join('originals', shard, trackId), sha256, coverKey, remote.genre || '', remote.year, remote.track_number, remote.disc_number);
        for (const liker of likers) await tx.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(liker.user_id, trackId);
        await tx.prepare("INSERT INTO track_sources(source,source_id,track_id) VALUES('federation',?,?)").run(sourceId, trackId);
        await tx.prepare('DELETE FROM federation_remote_likes WHERE origin_node_id=? AND object_id=?').run(job.origin_node_id, job.object_id);
        await tx.prepare("UPDATE federation_remote_replicas SET status='imported',local_track_id=?,storage_key=NULL,mime_type=?,size_bytes=?,received_bytes=?,sha256=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(trackId, mimeType, total, total, sha256, job.origin_node_id, job.object_id);
      });
    } catch (error) {
      fs.renameSync(destination, paths.temporaryPath);
      if (coverKey) fs.rmSync(path.join(storageDir, coverKey), { force:true });
      throw error;
    }
  }

  async function claim() {
    return db.transaction(async tx => {
      const result = await tx.prepare(`UPDATE federation_remote_replicas SET status='downloading',attempts=attempts+1,error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE (origin_node_id,object_id)=(SELECT origin_node_id,object_id FROM federation_remote_replicas
          WHERE status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`).run();
      return result.rows[0] ?? null;
    });
  }

  async function processNext() {
    if (busy) return false;
    busy = true;
    let job;
    let finish;
    let succeeded = false;
    try {
      job = await claim();
      if (!job) return false;
      finish = startOperation?.('federation.import');
      const peer = await db.prepare("SELECT * FROM federation_peers WHERE node_id=? AND revoked_at IS NULL AND status IN ('compatible','limited')").get(job.origin_node_id);
      const identity = loadIdentity();
      if (!peer || !identity) throw new Error('Исходная нода недоступна или доверие отозвано');
      const paths = federationReplicaPaths(storageDir, job.origin_node_id, job.object_id);
      fs.mkdirSync(path.dirname(paths.temporaryPath), { recursive:true, mode:0o750 });
      let offset = fs.existsSync(paths.temporaryPath) ? fs.statSync(paths.temporaryPath).size : 0;
      if (offset && Number(job.size_bytes) === offset && /^[0-9a-f]{64}$/.test(String(job.sha256 || ''))) {
        const existingSha = await sha256File(paths.temporaryPath);
        if (existingSha === job.sha256) { await complete(job, paths, job.mime_type || 'application/octet-stream', offset, existingSha); succeeded = true; return true; }
        fs.rmSync(paths.temporaryPath, { force:true }); offset = 0;
      }
      const query = new URLSearchParams({ quality:'original' });
      if (offset) query.set('range', `bytes=${offset}-`);
      const remotePath = `/federation/v1/tracks/${encodeURIComponent(job.object_id)}/stream?${query}`;
      const targetUri = `${peer.endpoint.replace(/\/$/, '')}${remotePath}`;
      const headers = signFederationRequest({ method:'GET', targetUri, nodeId:identity.node_id, privateKeyPem:identity.private_key_pem });
      const upstream = await openStream(peer.endpoint, remotePath, headers, { timeoutMs:30000 });
      const status = upstream.response.statusCode || 502;
      if (status !== 200 && status !== 206) { upstream.response.resume(); throw new Error(`Исходная нода вернула HTTP ${status}`); }
      if (offset && status !== 206) { fs.rmSync(paths.temporaryPath, { force:true }); offset = 0; }
      const range = String(upstream.response.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (status === 206 && (!range || Number(range[1]) !== offset)) { upstream.response.destroy(); throw new Error('Исходная нода вернула неверный Content-Range'); }
      const contentLength = Number(upstream.response.headers['content-length']);
      const total = range ? Number(range[3]) : contentLength;
      if (!Number.isSafeInteger(total) || total <= 0) { upstream.response.destroy(); throw new Error('Исходная нода не сообщила корректный размер оригинала'); }
      await db.prepare("UPDATE federation_remote_replicas SET size_bytes=?,received_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=? AND status='downloading'").run(total, offset, job.origin_node_id, job.object_id);
      const output = fs.createWriteStream(paths.temporaryPath, { flags:offset ? 'a' : 'w', mode:0o640 });
      let received = offset;
      let reported = offset;
      try {
        for await (const chunk of upstream.response) {
          received += chunk.length;
          if (received > total) throw new Error('Получено больше заявленного размера оригинала');
          if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
          if (received - reported >= 1024 * 1024) {
            reported = received;
            await db.prepare("UPDATE federation_remote_replicas SET received_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=? AND status='downloading'").run(received, job.origin_node_id, job.object_id);
          }
        }
        await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
      } catch (error) { output.destroy(); throw error; }
      if (received !== total) throw new Error(`Оригинал загружен не полностью: ${received} из ${total}`);
      const actualSha256 = await sha256File(paths.temporaryPath);
      const expectedSha256 = String(upstream.response.headers['x-music-sha256'] || '').toLowerCase();
      if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('Исходная нода вернула некорректный SHA-256');
      if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error('SHA-256 реплики не совпадает с оригиналом');
      const current = await db.prepare('SELECT status FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(job.origin_node_id, job.object_id);
      if (!current || current.status !== 'downloading') { fs.rmSync(paths.temporaryPath, { force:true }); return false; }
      await complete(job, paths, String(upstream.response.headers['content-type'] || 'application/octet-stream'), total, actualSha256);
      succeeded = true;
      return true;
    } catch (error) {
      if (job) {
        const paths = federationReplicaPaths(storageDir, job.origin_node_id, job.object_id);
        const received = fs.existsSync(paths.temporaryPath) ? fs.statSync(paths.temporaryPath).size : 0;
        await db.prepare("UPDATE federation_remote_replicas SET status='retry',received_bytes=?,available_at=CURRENT_TIMESTAMP+(? * INTERVAL '1 second'),error=?,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(received, federationImportRetryDelay(job.attempts), String(error.message || error).slice(0, 1000), job.origin_node_id, job.object_id);
        logger.error(`Ошибка репликации ${job.object_id}:`, error.message || error);
      }
      return false;
    } finally { await finish?.(succeeded); busy = false; }
  }

  async function recover() {
    await db.prepare("UPDATE federation_remote_replicas SET status='retry',available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE status='downloading'").run();
    const ready = await db.prepare("SELECT * FROM federation_remote_replicas WHERE status='ready' AND storage_key IS NOT NULL").all();
    for (const replica of ready) {
      const paths = federationReplicaPaths(storageDir, replica.origin_node_id, replica.object_id);
      const source = path.resolve(storageDir, replica.storage_key);
      fs.mkdirSync(path.dirname(paths.temporaryPath), { recursive:true, mode:0o750 });
      if (source.startsWith(`${path.resolve(storageDir)}${path.sep}`) && fs.existsSync(source)) fs.renameSync(source, paths.temporaryPath);
      await db.prepare("UPDATE federation_remote_replicas SET status='queued',storage_key=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(replica.origin_node_id, replica.object_id);
    }
    await db.prepare(`INSERT INTO federation_remote_replicas(origin_node_id,object_id,status)
      SELECT DISTINCT origin_node_id,object_id,'queued' FROM federation_remote_likes ON CONFLICT(origin_node_id,object_id) DO NOTHING`).run();
  }

  function removeTemporary(nodeId, objectId) {
    fs.rmSync(federationReplicaPaths(storageDir, nodeId, objectId).temporaryPath, { force:true });
  }

  return { processNext, recover, removeTemporary };
}
