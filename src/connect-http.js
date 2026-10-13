const DEVICE_PATH = /^\/api\/connect\/devices\/([a-zA-Z0-9_-]{16,96})$/;
const ACK_PATH = /^\/api\/connect\/commands\/(\d+)\/ack$/;

export function createConnectHttpController({ connect, readJson, sendJson }) {
  async function handle(req, res, url, user) {
    if (url.pathname === '/api/connect/status' && req.method === 'GET') {
      sendJson(res, 200, { enabled:connect.enabled, transport:'polling', poll_interval_ms:1500 });
      return true;
    }
    if (!url.pathname.startsWith('/api/connect/')) return false;
    if (!connect.enabled) {
      sendJson(res, 404, { error:'Family Music Connect выключен', error_code:'connect_disabled' });
      return true;
    }
    if (url.pathname === '/api/connect/devices' && req.method === 'POST') {
      const result = await connect.registerDevice(user.id, await readJson(req, 64 * 1024));
      if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
      else if (result.status === 'conflict') sendJson(res, 409, { error:result.error });
      else sendJson(res, 200, result);
      return true;
    }
    if (url.pathname === '/api/connect/devices' && req.method === 'GET') {
      sendJson(res, 200, { items:await connect.listDevices(user.id), state:await connect.getState(user.id) });
      return true;
    }
    const device = DEVICE_PATH.exec(url.pathname);
    if (device && req.method === 'DELETE') {
      if (!await connect.revokeDevice(user.id, device[1])) sendJson(res, 404, { error:'Connect-устройство не найдено' });
      else sendJson(res, 200, { ok:true });
      return true;
    }
    if (url.pathname === '/api/connect/state' && req.method === 'GET') {
      sendJson(res, 200, await connect.getState(user.id));
      return true;
    }
    if (url.pathname === '/api/connect/state' && req.method === 'PUT') {
      const body = await readJson(req, 1024 * 1024);
      const result = await connect.updateState(user.id, String(body.device_id || ''), body);
      if (result.status === 'missing_device') sendJson(res, 404, { error:'Connect-устройство не зарегистрировано' });
      else if (result.status === 'not_active') sendJson(res, 409, { error:'Состояние может менять только активное устройство', state:result.state });
      else if (result.status === 'stale_epoch') sendJson(res, 409, { error:'Устаревшая эпоха Connect-плеера', error_code:'connect_stale_epoch', state:result.state });
      else sendJson(res, 200, result.state);
      return true;
    }
    if (url.pathname === '/api/connect/transfer' && req.method === 'POST') {
      const body = await readJson(req, 1024 * 1024);
      const result = await connect.requestTransfer(user.id, String(body.source_device_id || ''), String(body.target_device_id || ''), body.state || {});
      if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
      else if (result.status === 'missing_device') sendJson(res, 404, { error:'Устройство не найдено или недоступно' });
      else sendJson(res, 202, result);
      return true;
    }
    if (url.pathname === '/api/connect/commands' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const result = await connect.sendCommand(user.id, String(body.source_device_id || ''), String(body.action || ''), body.payload || {});
      if (result.status === 'invalid') sendJson(res, 400, { error:result.error });
      else if (result.status === 'missing_device') sendJson(res, 404, { error:'Управляющее устройство не зарегистрировано' });
      else if (result.status === 'no_active_device') sendJson(res, 409, { error:'Активное устройство не выбрано' });
      else if (result.status === 'target_offline') sendJson(res, 409, { error:'Активное устройство недоступно' });
      else sendJson(res, 202, result);
      return true;
    }
    if (url.pathname === '/api/connect/commands' && req.method === 'GET') {
      const items = await connect.pollCommands(user.id, String(url.searchParams.get('device_id') || ''), url.searchParams.get('after'));
      if (!items) sendJson(res, 404, { error:'Connect-устройство не зарегистрировано' });
      else sendJson(res, 200, { items, state:await connect.getState(user.id) });
      return true;
    }
    const acknowledgement = ACK_PATH.exec(url.pathname);
    if (acknowledgement && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const result = await connect.acknowledge(user.id, String(body.device_id || ''), Number(acknowledgement[1]), body);
      if (result.status === 'missing') sendJson(res, 404, { error:'Connect-команда не найдена или уже завершена' });
      else sendJson(res, 200, result);
      return true;
    }
    return false;
  }

  return { handle };
}
