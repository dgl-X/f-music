import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_FILTER = "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease";

export function createArtistAlbumHttpController({ catalog, db, storageDir, uploadDir, artistDir, albumDir, readJson, readBytes, runProcess, sendJson }) {
  const safeStoredPath = key => {
    const file = path.resolve(storageDir, key);
    return file.startsWith(`${path.resolve(storageDir)}${path.sep}`) ? file : null;
  };

  const removeStoredFile = key => {
    const file = key && safeStoredPath(key);
    if (file) fs.rmSync(file, { force:true });
  };

  const serveImage = (res, key, varyCookie = false) => {
    const file = key && safeStoredPath(key);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const headers = { 'Content-Type':'image/jpeg', 'Cache-Control':'private, max-age=3600' };
    if (varyCookie) headers.Vary = 'Cookie';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  };

  async function convertImage(req, destination, sourceSuffix, temporaryDestination = false) {
    const source = path.join(uploadDir, `${crypto.randomUUID()}.${sourceSuffix}-source`);
    const temporary = temporaryDestination ? path.join(uploadDir, `${crypto.randomUUID()}.${sourceSuffix}.jpg`) : destination;
    try {
      fs.writeFileSync(source, await readBytes(req, MAX_IMAGE_BYTES), { mode:0o640 });
      const ok = await runProcess('ffmpeg', ['-loglevel','error','-y','-i',source,'-frames:v','1','-vf',IMAGE_FILTER,'-q:v','2',temporary]);
      if (!ok || !fs.existsSync(temporary)) return false;
      if (temporaryDestination) fs.renameSync(temporary, destination);
      return true;
    } finally {
      fs.rmSync(source, { force:true });
      if (temporaryDestination) fs.rmSync(temporary, { force:true });
    }
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (url.pathname === '/api/artists' && req.method === 'GET') {
      sendJson(res, 200, await catalog.lookupArtists({ searchParams:url.searchParams }));
      return true;
    }

    const artistMatch = /^\/api\/artists\/(\d+)$/.exec(url.pathname);
    if (artistMatch && req.method === 'GET') {
      const artist = await catalog.getArtist({ artistId:Number(artistMatch[1]), responsePrefix:apiPrefix });
      sendJson(res, artist ? 200 : 404, artist || { error:'Исполнитель не найден' });
      return true;
    }
    if (artistMatch && req.method === 'PATCH') {
      if (!user.is_admin) {
        sendJson(res, 403, { error:'Только администратор может изменять карточку исполнителя' });
        return true;
      }
      const artist = await db.prepare('SELECT id FROM artists WHERE id=?').get(Number(artistMatch[1]));
      if (!artist) {
        sendJson(res, 404, { error:'Исполнитель не найден' });
        return true;
      }
      const body = await readJson(req);
      await db.prepare('UPDATE artists SET bio=? WHERE id=?').run(String(body.bio || '').trim().slice(0, 5000), artist.id);
      sendJson(res, 200, { ok:true });
      return true;
    }

    const artistImageMatch = /^\/api\/artists\/(\d+)\/image$/.exec(url.pathname);
    if (artistImageMatch && req.method === 'GET') {
      const artist = await db.prepare('SELECT image_key FROM artists WHERE id=?').get(Number(artistImageMatch[1]));
      serveImage(res, artist?.image_key);
      return true;
    }
    if (artistImageMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!user.is_admin) {
        sendJson(res, 403, { error:'Только администратор может изменять изображение исполнителя' });
        return true;
      }
      const artist = await db.prepare('SELECT id,image_key FROM artists WHERE id=?').get(Number(artistImageMatch[1]));
      if (!artist) {
        sendJson(res, 404, { error:'Исполнитель не найден' });
        return true;
      }
      if (req.method === 'DELETE') {
        removeStoredFile(artist.image_key);
        await db.prepare('UPDATE artists SET image_key=NULL WHERE id=?').run(artist.id);
        sendJson(res, 200, { ok:true, image_url:null });
        return true;
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('image/')) {
        sendJson(res, 415, { error:'Нужен файл изображения' });
        return true;
      }
      const target = path.join(artistDir, `${artist.id}.jpg`);
      if (!await convertImage(req, target, 'artist')) {
        sendJson(res, 400, { error:'Не удалось прочитать изображение' });
        return true;
      }
      await db.prepare('UPDATE artists SET image_key=? WHERE id=?').run(path.join('artists', `${artist.id}.jpg`), artist.id);
      sendJson(res, 200, { ok:true, image_url:`${apiPrefix}/artists/${artist.id}/image?v=${Date.now()}` });
      return true;
    }

    const albumMatch = /^\/api\/albums\/(\d+)$/.exec(url.pathname);
    if (albumMatch && req.method === 'GET') {
      const album = await catalog.getAlbum({ albumId:Number(albumMatch[1]), userId:user.id, isAdmin:Boolean(user.is_admin), responsePrefix:apiPrefix });
      sendJson(res, album ? 200 : 404, album || { error:'Альбом не найден' });
      return true;
    }
    if (albumMatch && req.method === 'PATCH') {
      const album = await db.prepare('SELECT id,name,artist,bio,image_key,year FROM albums WHERE id=?').get(Number(albumMatch[1]));
      if (!album) {
        sendJson(res, 404, { error:'Альбом не найден' });
        return true;
      }
      const canEdit = () => catalog.canEditAlbum({ userId:user.id, isAdmin:Boolean(user.is_admin), albumId:album.id });
      if (!await canEdit()) {
        sendJson(res, 403, { error:'Недостаточно прав для изменения альбома' });
        return true;
      }
      const body = await readJson(req), bio = String(body.bio ?? '').trim();
      if (bio.length > 5000) {
        sendJson(res, 400, { error:'Описание слишком длинное' });
        return true;
      }
      await db.prepare('UPDATE albums SET bio=? WHERE id=?').run(bio, album.id);
      sendJson(res, 200, { ...album, bio, image_url:album.image_key ? `${apiPrefix}/albums/${album.id}/image` : null, image_key:undefined, can_edit:await canEdit() });
      return true;
    }

    const albumImageMatch = /^\/api\/albums\/(\d+)\/image$/.exec(url.pathname);
    if (albumImageMatch && req.method === 'GET') {
      const album = await db.prepare('SELECT image_key FROM albums WHERE id=?').get(Number(albumImageMatch[1]));
      serveImage(res, album?.image_key, true);
      return true;
    }
    if (albumImageMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const album = await db.prepare('SELECT id,image_key FROM albums WHERE id=?').get(Number(albumImageMatch[1]));
      if (!album) {
        sendJson(res, 404, { error:'Альбом не найден' });
        return true;
      }
      const canEdit = await catalog.canEditAlbum({ userId:user.id, isAdmin:Boolean(user.is_admin), albumId:album.id });
      if (!canEdit) {
        sendJson(res, 403, { error:'Недостаточно прав для изменения альбома' });
        return true;
      }
      if (req.method === 'DELETE') {
        await db.prepare('UPDATE albums SET image_key=NULL WHERE id=?').run(album.id);
        removeStoredFile(album.image_key);
        sendJson(res, 200, { ok:true, image_url:null });
        return true;
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('image/')) {
        sendJson(res, 415, { error:'Нужен файл изображения' });
        return true;
      }
      const target = path.join(albumDir, `${album.id}.jpg`);
      if (!await convertImage(req, target, 'album', true)) {
        sendJson(res, 400, { error:'Не удалось прочитать изображение' });
        return true;
      }
      await db.prepare('UPDATE albums SET image_key=? WHERE id=?').run(path.join('albums', `${album.id}.jpg`), album.id);
      sendJson(res, 200, { ok:true, image_url:`${apiPrefix}/albums/${album.id}/image?v=${Date.now()}` });
      return true;
    }
    return false;
  }

  return { handle };
}
