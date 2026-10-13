import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TRACK_ID = /^[0-9a-f-]{36}$/;
const IMAGE_FILTER = "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function createTrackManagementHttpController({ catalog, db, storageDir, uploadDir, coverDir, readJson, readBytes, runProcess, sendJson }) {
  const canEditAlbum = (user, albumId) => catalog.canEditAlbum({ userId:user.id, isAdmin:Boolean(user.is_admin), albumId });
  const canEditTrack = (user, track) => track.owner_id === user.id || Boolean(user.is_admin);
  const safeFile = key => {
    const file = path.resolve(storageDir, key);
    return file.startsWith(`${path.resolve(storageDir)}${path.sep}`) ? file : null;
  };
  const removeFile = key => {
    const file = key && safeFile(key);
    if (file) fs.rmSync(file, { force:true });
  };
  const clean = (value, max = 240) => String(value ?? '').trim().slice(0, max);

  async function batchMetadata(req, res, user) {
    const body = await readJson(req, 1024 * 1024), items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    const ids = [...new Set(items.map(item => String(item.id || '')).filter(id => TRACK_ID.test(id)))];
    if (!ids.length) return sendJson(res, 400, { error:'Выберите хотя бы один трек' });
    const tracks = await db.prepare('SELECT id,owner_id,artist,album_id FROM tracks WHERE id = ANY(@ids)').all({ ids });
    if (tracks.length !== ids.length) return sendJson(res, 404, { error:'Один из треков не найден' });
    if (!user.is_admin && tracks.some(track => track.owner_id !== user.id)) return sendJson(res, 403, { error:'Недостаточно прав для изменения одного из треков' });
    const artist = clean(body.artist), album = clean(body.album), genre = clean(body.genre, 120);
    const year = body.year === '' || body.year == null ? null : Number(body.year);
    if (!album) return sendJson(res, 400, { error:'Введите название альбома' });
    if (year !== null && (!Number.isInteger(year) || year < 1000 || year > 9999)) return sendJson(res, 400, { error:'Некорректный год' });
    const requestedAlbumId = Number(body.album_id) || 0;
    if (requestedAlbumId && (!Number.isSafeInteger(requestedAlbumId) || !tracks.some(track => Number(track.album_id) === requestedAlbumId))) return sendJson(res, 400, { error:'Альбом не соответствует выбранным трекам' });
    const existingAlbum = requestedAlbumId ? await db.prepare('SELECT id,artist FROM albums WHERE id=?').get(requestedAlbumId) : null;
    if (requestedAlbumId && !existingAlbum) return sendJson(res, 404, { error:'Альбом не найден' });
    const firstArtist = tracks.find(track => track.id === ids[0])?.artist || 'Неизвестный исполнитель';
    const albumArtist = artist || existingAlbum?.artist || firstArtist.replace(/\s+(feat(?:uring)?\.?|ft\.?).*$/i, '').split(',')[0].trim() || 'Неизвестный исполнитель';
    const conflicting = await db.prepare('SELECT id FROM albums WHERE lower(name)=lower(?) AND lower(artist)=lower(?)').get(album, albumArtist);
    if (conflicting && requestedAlbumId && Number(conflicting.id) !== requestedAlbumId) return sendJson(res, 409, { error:'Альбом с таким названием и исполнителем уже существует' });
    if (!user.is_admin && (requestedAlbumId || conflicting) && !await canEditAlbum(user, requestedAlbumId || conflicting.id)) return sendJson(res, 403, { error:'Недостаточно прав для изменения общего альбома' });
    let savedAlbumId;
    await db.transaction(async tx => {
      if (requestedAlbumId) {
        await tx.prepare('UPDATE albums SET name=?,artist=?,year=COALESCE(?,year) WHERE id=?').run(album, albumArtist, year, requestedAlbumId);
        await tx.prepare('UPDATE tracks SET album=? WHERE album_id=? AND album<>?').run(album, requestedAlbumId, album);
        savedAlbumId = requestedAlbumId;
      } else {
        const saved = await tx.prepare(`INSERT INTO albums(name,artist,year) VALUES(?,?,?) ON CONFLICT((lower(name)),(lower(artist))) DO UPDATE SET year=COALESCE(EXCLUDED.year,albums.year) RETURNING id`).get(album, albumArtist, year);
        savedAlbumId = Number(saved.id);
      }
      for (let index = 0; index < items.length; index++) {
        const item = items[index], id = String(item.id || '');
        if (!ids.includes(id)) continue;
        const trackNumber = Number.isInteger(Number(item.track_number)) && Number(item.track_number) > 0 ? Number(item.track_number) : index + 1;
        const discNumber = Number.isInteger(Number(item.disc_number)) && Number(item.disc_number) > 0 ? Number(item.disc_number) : 1;
        await tx.prepare(`UPDATE tracks SET album=@album,album_id=@album_id,genre=CASE WHEN @genre='' THEN genre ELSE @genre END,year=COALESCE(@year,year),track_number=@track_number,disc_number=@disc_number WHERE id=@id`).run({ album, album_id:savedAlbumId, genre, year, track_number:trackNumber, disc_number:discNumber, id });
      }
    });
    sendJson(res, 200, { ok:true, updated:ids.length, album_id:savedAlbumId });
  }

  async function batchCover(req, res, user) {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('image/')) return sendJson(res, 415, { error:'Нужен файл изображения' });
    const ids = [...new Set(String(req.headers['x-track-ids'] || '').split(',').map(id => id.trim()).filter(id => TRACK_ID.test(id)))].slice(0, 150);
    if (ids.length < 2) return sendJson(res, 400, { error:'Для общей обложки нужно минимум два трека' });
    const tracks = await db.prepare('SELECT id,owner_id,cover_key FROM tracks WHERE id = ANY(@ids)').all({ ids });
    if (tracks.length !== ids.length) return sendJson(res, 404, { error:'Один из треков не найден' });
    if (!user.is_admin && tracks.some(track => track.owner_id !== user.id)) return sendJson(res, 403, { error:'Недостаточно прав для изменения одного из треков' });
    const source = path.join(uploadDir, `${crypto.randomUUID()}.cover-source`), converted = path.join(uploadDir, `${crypto.randomUUID()}.cover.jpg`), temporary = [];
    try {
      fs.writeFileSync(source, await readBytes(req, MAX_IMAGE_BYTES), { mode:0o640 });
      const ok = await runProcess('ffmpeg', ['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',IMAGE_FILTER,'-q:v','2',converted]);
      if (!ok || !fs.existsSync(converted)) return sendJson(res, 400, { error:'Не удалось прочитать изображение' });
      const updates = [];
      for (const track of tracks) {
        const shard = track.id.slice(0, 2), destinationDir = path.join(coverDir, shard), coverKey = path.join('covers', shard, `${track.id}.jpg`), target = path.join(storageDir, coverKey), temp = `${target}.${crypto.randomUUID()}.tmp`;
        fs.mkdirSync(destinationDir, { recursive:true, mode:0o750 });
        fs.copyFileSync(converted, temp); temporary.push(temp); fs.renameSync(temp, target);
        updates.push({ id:track.id, coverKey, previous:track.cover_key });
      }
      await db.transaction(async tx => { for (const item of updates) await tx.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=?').run(item.coverKey, item.id); });
      for (const item of updates) if (item.previous && item.previous !== item.coverKey) removeFile(item.previous);
      sendJson(res, 200, { ok:true, updated:updates.length });
    } finally {
      fs.rmSync(source, { force:true }); fs.rmSync(converted, { force:true });
      for (const file of temporary) fs.rmSync(file, { force:true });
    }
  }

  async function trackArtists(req, res, user, trackId) {
    const track = await db.prepare(req.method === 'GET' ? 'SELECT id FROM tracks WHERE id=?' : 'SELECT id,owner_id FROM tracks WHERE id=?').get(trackId);
    if (!track) return sendJson(res, 404, { error:'Трек не найден' });
    if (req.method === 'PUT' && !canEditTrack(user, track)) return sendJson(res, 403, { error:'Недостаточно прав' });
    if (req.method === 'PUT') {
      const body = await readJson(req), source = Array.isArray(body.items) ? body.items.slice(0, 20) : [], seen = new Set(), credits = [];
      for (const item of source) {
        const name = clean(item?.name), role = item?.role === 'featured' ? 'featured' : 'primary', key = name.toLocaleLowerCase();
        if (name && !seen.has(key)) { seen.add(key); credits.push({ name, role }); }
      }
      if (!credits.length || !credits.some(item => item.role === 'primary')) return sendJson(res, 400, { error:'Добавьте хотя бы одного основного исполнителя' });
      const primary = credits.filter(item => item.role === 'primary').map(item => item.name), featured = credits.filter(item => item.role === 'featured').map(item => item.name);
      const label = primary.join(', ') + (featured.length ? ` feat. ${featured.join(', ')}` : '');
      await db.transaction(async tx => {
        await tx.prepare('UPDATE tracks SET artist=? WHERE id=?').run(label, track.id);
        for (const item of credits) await tx.prepare(`UPDATE track_artists SET role=? WHERE track_id=? AND artist_id=(SELECT id FROM artists WHERE lower(name)=lower(?) LIMIT 1)`).run(item.role, track.id, item.name);
      });
      const items = await db.prepare(`SELECT artists.id,artists.name,track_artists.role,track_artists.position FROM track_artists JOIN artists ON artists.id=track_artists.artist_id WHERE track_artists.track_id=? ORDER BY track_artists.position`).all(track.id);
      return sendJson(res, 200, { artist:label, items });
    }
    const items = await db.prepare(`SELECT artists.id,artists.name,track_artists.role,track_artists.position FROM track_artists JOIN artists ON artists.id=track_artists.artist_id WHERE track_artists.track_id=? ORDER BY track_artists.position`).all(track.id);
    sendJson(res, 200, { items });
  }

  async function mutateTrack(req, res, user, trackId) {
    const track = await db.prepare('SELECT * FROM tracks WHERE id=?').get(trackId);
    if (!track) return sendJson(res, 404, { error:'Трек не найден' });
    if (!canEditTrack(user, track)) return sendJson(res, 403, { error:'Недостаточно прав' });
    if (req.method === 'DELETE') {
      const derived = await db.prepare("SELECT storage_key FROM track_files WHERE track_id=? AND storage_key IS NOT NULL").all(track.id);
      await db.prepare('DELETE FROM tracks WHERE id=?').run(track.id);
      for (const key of [track.storage_key, track.cover_key, ...derived.map(item => item.storage_key)]) removeFile(key);
      return sendJson(res, 200, { ok:true });
    }
    const body = await readJson(req), title = clean(body.title), artist = clean(body.artist);
    if (!title || !artist) return sendJson(res, 400, { error:'Название и исполнитель обязательны' });
    const year = body.year === '' || body.year == null ? null : Number(body.year);
    if (year !== null && (!Number.isInteger(year) || year < 1000 || year > 9999)) return sendJson(res, 400, { error:'Некорректный год' });
    await db.prepare('UPDATE tracks SET title=?,artist=?,album=?,genre=?,year=? WHERE id=?').run(title, artist, clean(body.album), clean(body.genre), year, track.id);
    sendJson(res, 200, { ok:true });
  }

  async function trackCover(req, res, user, trackId, apiPrefix) {
    const fields = req.method === 'GET' ? 'cover_key' : '*';
    const track = await db.prepare(`SELECT ${fields} FROM tracks WHERE id=?`).get(trackId);
    if (req.method === 'GET') {
      const file = track?.cover_key && safeFile(track.cover_key);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type':'image/jpeg', 'Cache-Control':'private, max-age=3600, stale-while-revalidate=86400', 'Vary':'Cookie' });
      fs.createReadStream(file).pipe(res); return;
    }
    if (!track) return sendJson(res, 404, { error:'Трек не найден' });
    if (!canEditTrack(user, track)) return sendJson(res, 403, { error:'Недостаточно прав' });
    if (req.method === 'DELETE') {
      removeFile(track.cover_key);
      await db.prepare('UPDATE tracks SET cover_key=NULL,cover_checked=1 WHERE id=?').run(track.id);
      return sendJson(res, 200, { ok:true, cover_url:null });
    }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('image/')) return sendJson(res, 415, { error:'Нужен файл изображения' });
    const source = path.join(uploadDir, `${crypto.randomUUID()}.cover-source`), converted = path.join(uploadDir, `${crypto.randomUUID()}.cover.jpg`);
    try {
      fs.writeFileSync(source, await readBytes(req, MAX_IMAGE_BYTES), { mode:0o640 });
      const ok = await runProcess('ffmpeg', ['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',IMAGE_FILTER,'-q:v','2',converted]);
      if (!ok || !fs.existsSync(converted)) return sendJson(res, 400, { error:'Не удалось прочитать изображение' });
      const shard = track.id.slice(0, 2), destinationDir = path.join(coverDir, shard), coverKey = path.join('covers', shard, `${track.id}.jpg`);
      fs.mkdirSync(destinationDir, { recursive:true, mode:0o750 });
      fs.renameSync(converted, path.join(storageDir, coverKey));
      if (track.cover_key !== coverKey) removeFile(track.cover_key);
      await db.prepare('UPDATE tracks SET cover_key=?,cover_checked=1 WHERE id=?').run(coverKey, track.id);
      sendJson(res, 200, { ok:true, cover_url:`${apiPrefix}/tracks/${track.id}/cover?v=${Date.now()}` });
    } finally { fs.rmSync(source, { force:true }); fs.rmSync(converted, { force:true }); }
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (url.pathname === '/api/duplicates' && req.method === 'GET') { sendJson(res, 200, await catalog.listDuplicates({ userId:user.id, isAdmin:Boolean(user.is_admin), responsePrefix:apiPrefix })); return true; }
    if (url.pathname === '/api/tracks/batch' && req.method === 'POST') { await batchMetadata(req, res, user); return true; }
    if (url.pathname === '/api/tracks/batch-cover' && req.method === 'PUT') { await batchCover(req, res, user); return true; }
    const artistsMatch = /^\/api\/tracks\/([0-9a-f-]+)\/artists$/.exec(url.pathname);
    if (artistsMatch && (req.method === 'GET' || req.method === 'PUT')) { await trackArtists(req, res, user, artistsMatch[1]); return true; }
    const trackMatch = /^\/api\/tracks\/([0-9a-f-]+)$/.exec(url.pathname);
    if (trackMatch && (req.method === 'PATCH' || req.method === 'DELETE')) { await mutateTrack(req, res, user, trackMatch[1]); return true; }
    const coverMatch = /^\/api\/tracks\/([0-9a-f-]+)\/cover$/.exec(url.pathname);
    if (coverMatch && ['GET','PUT','DELETE'].includes(req.method)) { await trackCover(req, res, user, coverMatch[1], apiPrefix); return true; }
    const likeMatch = /^\/api\/tracks\/([0-9a-f-]+)\/like$/.exec(url.pathname);
    if (likeMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const track = await db.prepare('SELECT id FROM tracks WHERE id=?').get(likeMatch[1]);
      if (!track) sendJson(res, 404, { error:'Трек не найден' });
      else {
        if (req.method === 'PUT') await db.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(user.id, track.id);
        else await db.prepare('DELETE FROM track_likes WHERE user_id=? AND track_id=?').run(user.id, track.id);
        sendJson(res, 200, { liked:req.method === 'PUT' });
      }
      return true;
    }
    return false;
  }

  return { handle };
}
