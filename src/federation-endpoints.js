import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return ((parts[0] * 0x1000000) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inV4(address, base, bits) {
  const value = ipv4Number(address), network = ipv4Number(base);
  if (value === null || network === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6Groups(address) {
  let value = address.toLowerCase();
  const dotted = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const number = ipv4Number(dotted[2]);
    if (number === null) return null;
    value = `${dotted[1]}${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || halves.length === 1 && missing !== 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(part => Number.parseInt(part, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

export function federationAddressClass(address) {
  if (net.isIP(address) === 4) {
    if (inV4(address, '127.0.0.0', 8)) return 'loopback';
    if (inV4(address, '169.254.0.0', 16)) return 'link-local';
    if (inV4(address, '10.0.0.0', 8) || inV4(address, '172.16.0.0', 12) || inV4(address, '192.168.0.0', 16)) return 'private';
    if (inV4(address, '0.0.0.0', 8) || inV4(address, '100.64.0.0', 10) || inV4(address, '192.0.0.0', 24) ||
      inV4(address, '192.0.2.0', 24) || inV4(address, '198.18.0.0', 15) || inV4(address, '198.51.100.0', 24) ||
      inV4(address, '203.0.113.0', 24) || inV4(address, '224.0.0.0', 4)) return 'reserved';
    return 'public';
  }
  if (net.isIP(address) === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return 'invalid';
    if (groups.slice(0, 7).every(group => group === 0) && groups[7] <= 1) return 'loopback';
    if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
      return federationAddressClass(`${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`);
    }
    if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((groups[0] & 0xfe00) === 0xfc00) return 'private';
    if ((groups[0] & 0xff00) === 0xff00 || groups[0] === 0x2001 && groups[1] === 0x0db8) return 'reserved';
    return 'public';
  }
  return 'invalid';
}

export async function resolveFederationEndpoint(value, scope, resolver = dns.lookup) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw Object.assign(new Error('Некорректный адрес ноды'), { code: 'invalid_endpoint' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw Object.assign(new Error('Нужен корневой HTTPS-адрес без логина, пути и параметров'), { code: 'invalid_endpoint' });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ''), literalFamily = net.isIP(hostname);
  if (scope === 'private' && !literalFamily) throw Object.assign(new Error('Внутренний endpoint должен содержать точный IP, а не DNS-имя'), { code: 'private_ip_required' });
  const records = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolver(hostname, { all: true, verbatim: true });
  if (!records.length) throw Object.assign(new Error('DNS не вернул адресов'), { code: 'dns_empty' });
  for (const record of records) {
    const kind = federationAddressClass(record.address);
    if (['loopback', 'link-local', 'reserved', 'invalid'].includes(kind) || scope === 'public' && kind !== 'public' || scope === 'private' && kind !== 'private') {
      throw Object.assign(new Error(`Адрес ${record.address} запрещён для endpoint ${scope}`), { code: 'endpoint_address_forbidden' });
    }
  }
  return { url: url.toString().replace(/\/$/, ''), hostname, addresses: records.map(record => ({ address: record.address, family: record.family })) };
}

export async function probeFederationEndpoint(value, scope, { timeoutMs = 8000, resolver } = {}) {
  const resolved = await resolveFederationEndpoint(value, scope, resolver);
  const selected = resolved.addresses[0], target = new URL(`${resolved.url}/federation/v1/node`);
  return await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'Family-Music-Federation/1' },
      lookup: (_hostname, options, callback) => options?.all
        ? callback(null, [selected])
        : callback(null, selected.address, selected.family),
    }, response => {
      let size = 0, text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= 65536) text += chunk; else request.destroy(new Error('Ответ endpoint слишком большой')); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Object.assign(new Error(`Endpoint вернул HTTP ${response.statusCode}`), { code: 'endpoint_http_error' }));
        try {
          const descriptor = JSON.parse(text);
          if (!/^fm:[A-Za-z0-9_-]{16,128}$/.test(descriptor.node_id || '')) throw new Error('В ответе нет корректного node_id');
          resolve({ ok: true, url: resolved.url, address: selected.address, node_id: descriptor.node_id, software_version: descriptor.software_version || '', protocols: descriptor.protocols || {} });
        } catch (error) { reject(Object.assign(new Error(error.message || 'Некорректный JSON endpoint'), { code: 'invalid_node_descriptor' })); }
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Истекло время проверки endpoint'), { code: 'endpoint_timeout' })));
    request.on('error', reject);
    request.end();
  });
}

export async function postFederationJson(value, path, body, headers, { timeoutMs = 10000, resolver } = {}) {
  const resolved = await resolveFederationEndpoint(value, 'public', resolver), selected = resolved.addresses[0];
  const target = new URL(path, `${resolved.url}/`), bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'POST', timeout: timeoutMs,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, ...headers },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, response => {
      let size = 0, text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= 65536) text += chunk; else request.destroy(new Error('Ответ endpoint слишком большой')); });
      response.on('end', () => {
        let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { return reject(new Error('Endpoint вернул некорректный JSON')); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(Object.assign(new Error(typeof json.error === 'string' ? json.error : json.error?.message || `Endpoint вернул HTTP ${response.statusCode}`), { code: json.code || json.error?.code || 'endpoint_http_error' }));
        resolve(json);
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Истекло время запроса к endpoint'), { code: 'endpoint_timeout' })));
    request.on('error', reject); request.end(bytes);
  });
}

export async function getFederationJson(value, path, headers, { timeoutMs = 10000, resolver } = {}) {
  const resolved = await resolveFederationEndpoint(value, 'public', resolver), selected = resolved.addresses[0];
  const target = new URL(path, `${resolved.url}/`);
  return await new Promise((resolve, reject) => {
    const request = https.request(target, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json', ...headers },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family) }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else request.destroy(new Error('Ответ endpoint слишком большой')); });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks); let body;
        try { body = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; } catch { return reject(new Error('Endpoint вернул некорректный JSON')); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(Object.assign(new Error(typeof body.error === 'string' ? body.error : body.error?.message || `Endpoint вернул HTTP ${response.statusCode}`), { code: body.error?.code || 'endpoint_http_error' }));
        resolve({ body, bytes, headers: response.headers });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Истекло время запроса к endpoint'), { code: 'endpoint_timeout' })));
    request.on('error', reject); request.end();
  });
}

export async function openFederationStream(value, path, headers, { timeoutMs = 12000, resolver } = {}) {
  const resolved=await resolveFederationEndpoint(value,'public',resolver),selected=resolved.addresses[0],target=new URL(path,`${resolved.url}/`);
  return await new Promise((resolve,reject)=>{
    const request=https.request(target,{method:'GET',timeout:timeoutMs,headers:{Accept:'audio/*, application/json',...headers},lookup:(_hostname,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family)},response=>{request.setTimeout(0);resolve({request,response});});
    request.on('timeout',()=>request.destroy(Object.assign(new Error('Истекло время подключения к аудиопотоку'),{code:'stream_timeout'})));
    request.on('error',reject);request.end();
  });
}
