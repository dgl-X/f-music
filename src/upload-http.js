const UPLOAD_PATH = /^\/api\/uploads\/([0-9a-f-]+)$/;

export function createUploadHttpController({ uploads, readJson, sendJson }) {
  async function handle(req, res, url, user) {
    if (url.pathname === '/api/uploads' && req.method === 'GET') {
      sendJson(res, 200, await uploads.list({ userId:user.id }));
      return true;
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const result = await uploads.create({ userId:user.id, input:await readJson(req) });
      if (result.status === 'invalid') sendJson(res, 400, { error:'Некорректное имя или размер файла' });
      else sendJson(res, 201, { id:result.id, offset:result.offset, size:result.size });
      return true;
    }
    const match = UPLOAD_PATH.exec(url.pathname);
    if (!match || !['GET', 'HEAD', 'PUT'].includes(req.method)) return false;
    const upload = await uploads.get({ uploadId:match[1], userId:user.id });
    if (!upload) {
      sendJson(res, 404, { error:'Загрузка не найдена' });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        id:upload.id,
        offset:upload.received_bytes,
        size:upload.total_bytes,
        status:upload.status,
        error:upload.error,
        track_id:upload.track_id,
      });
      return true;
    }
    if (req.method === 'HEAD') {
      res.writeHead(204, {
        'Upload-Offset':String(upload.received_bytes),
        'Upload-Length':String(upload.total_bytes),
        'Upload-Status':upload.status,
      });
      res.end();
      return true;
    }
    const result = await uploads.writePart({
      upload,
      contentRange:req.headers['content-range'],
      contentLength:req.headers['content-length'],
      chunks:req,
    });
    if (result.status === 'complete') sendJson(res, 409, { error:'Загрузка уже завершена' });
    else if (result.status === 'offset_mismatch' || result.status === 'busy') sendJson(res, 409, { error:'Неверное смещение', expected_offset:result.expectedOffset });
    else if (result.status === 'length_mismatch') sendJson(res, 400, { error:'Размер части не совпадает с Content-Range' });
    else if (result.status === 'too_large') sendJson(res, 400, { error:'Получено слишком много данных' });
    else if (result.status === 'incomplete') sendJson(res, 400, { error:'Получена неполная часть' });
    else sendJson(res, result.status === 'accepted' ? 202 : 200, { offset:result.offset, complete:result.complete, ...(result.processing ? { processing:true } : {}) });
    return true;
  }

  return { handle };
}
