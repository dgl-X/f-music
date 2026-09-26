import crypto from 'node:crypto';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,80}$/;

export function requestIdFrom(headers = {}) {
  const candidate = String(headers['x-request-id'] || '').split(',')[0].trim();
  return REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID();
}

export function requestKind(pathname) {
  if (pathname.startsWith('/federation/')) return 'federation';
  if (pathname.startsWith('/api/')) return 'api';
  return 'static';
}

export function createHttpObserver({ metrics, write = line => console.log(line), slowMs = 1000 }) {
  return function observe(req, res, url) {
    const requestId = requestIdFrom(req.headers);
    const started = process.hrtime.bigint();
    const kind = requestKind(url.pathname);
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    let completed = false;
    const complete = event => {
      if (completed) return;
      completed = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      metrics.requests++;
      metrics.duration_ms_total += durationMs;
      metrics.duration_ms_max = Math.max(metrics.duration_ms_max, durationMs);
      if (durationMs >= slowMs) metrics.slow_requests++;
      if (res.statusCode >= 500) metrics.errors5xx++;
      write(JSON.stringify({ time:new Date().toISOString(), level:res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', event:'http_request', request_id:requestId, method:req.method, path:url.pathname, kind, status:res.statusCode, duration_ms:Number(durationMs.toFixed(1)), completed:event === 'finish' }));
    };
    res.once('finish', () => complete('finish'));
    res.once('close', () => complete('close'));
    return requestId;
  };
}

export function httpMetricSnapshot(metrics) {
  return {
    requests:metrics.requests,
    errors_5xx:metrics.errors5xx,
    duration_ms_average:metrics.requests ? Number((metrics.duration_ms_total / metrics.requests).toFixed(1)) : 0,
    duration_ms_max:Number(metrics.duration_ms_max.toFixed(1)),
    slow_requests:metrics.slow_requests,
  };
}
