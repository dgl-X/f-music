const origin = String(process.env.LOADTEST_ORIGIN || '').replace(/\/$/, '');
const username = String(process.env.LOADTEST_USERNAME || '');
const password = String(process.env.LOADTEST_PASSWORD || '');

if (!origin || !username || !password) {
  console.error('Задайте LOADTEST_ORIGIN, LOADTEST_USERNAME и LOADTEST_PASSWORD');
  process.exit(2);
}

const timings = [];
let cookie = '';

async function request(path, options = {}, record = true) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
  });
  if (record) timings.push({ path, status: response.status, milliseconds: Math.round(performance.now() - started) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return { response, body: response.status === 204 ? null : await response.json() };
}

await request('/api/v1/login', { method: 'POST', body: JSON.stringify({ username, password, device_name: 'Android load-test smoke', client_name: 'load-test' }) });
const first = (await request('/api/v1/tracks?limit=50&offset=0&sort=title')).body;
const last = (await request('/api/v1/tracks?limit=50&offset=9950&sort=title')).body;
const search = (await request('/api/v1/tracks?limit=50&q=%D0%A2%D1%80%D0%B5%D0%BA%2009999')).body;
const queue = (await request('/api/v1/tracks?queue=1&limit=10000&sort=random&seed=android-smoke')).body;
const ids = queue.items.map(track => track.id);
const pagedIds = [];
const pagesStarted = performance.now();
for (let offset = 0; offset < 10000; offset += 100) {
  const page = (await request(`/api/v1/library?limit=100&offset=${offset}&sort=newest&scope=all`, {}, false)).body;
  pagedIds.push(...page.items.map(track => track.id));
}
timings.push({ path: '/library 100 страниц', status: 200, milliseconds: Math.round(performance.now() - pagesStarted) });
const save = await request('/api/v1/playback-state', { method: 'PUT', body: JSON.stringify({ track_id: ids[0], queue: ids, shuffle: true, repeat_mode: 'all', queue_source: 'Android smoke 10 000' }) });
const restored = (await request('/api/v1/playback-state')).body;

if (first.total !== 10000 || first.items.length !== 50 || last.items.length !== 50) throw new Error('Постраничный каталог содержит неверное число треков');
if (search.items.length !== 1) throw new Error('Поиск не нашёл единственный тестовый трек');
if (new Set(ids).size !== 10000) throw new Error('Shuffle-очередь содержит повторы или пропуски');
if (pagedIds.length !== 10000 || new Set(pagedIds).size !== 10000) throw new Error('Постраничный каталог содержит повторы или пропуски');
if (!save.body.ok || restored.queue.length !== 10000 || !restored.shuffle) throw new Error('Очередь из 10 000 треков не восстановилась');

const rangeStarted = performance.now();
const range = await fetch(`${origin}/api/v1/tracks/${ids[0]}/stream?quality=original`, { headers: { Cookie: cookie, Range: 'bytes=0-65535' } });
timings.push({ path: '/stream Range 64 KiB', status: range.status, milliseconds: Math.round(performance.now() - rangeStarted) });
if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 65536) throw new Error('Range-воспроизведение тестового файла не работает');

console.log(JSON.stringify({ ok: true, tracks: first.total, queue: restored.queue.length, timings }, null, 2));
