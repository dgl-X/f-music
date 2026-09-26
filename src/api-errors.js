const STATUS_CODES = new Map([
  [400, 'invalid_request'],
  [401, 'authentication_required'],
  [403, 'access_denied'],
  [404, 'not_found'],
  [405, 'method_not_allowed'],
  [408, 'request_timeout'],
  [409, 'conflict'],
  [410, 'resource_gone'],
  [413, 'payload_too_large'],
  [415, 'unsupported_media_type'],
  [422, 'unprocessable_content'],
  [429, 'rate_limited'],
  [500, 'internal_error'],
  [502, 'upstream_error'],
  [503, 'service_unavailable'],
  [504, 'upstream_timeout'],
]);

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

export function defaultErrorCode(status) {
  return STATUS_CODES.get(Number(status)) || (Number(status) >= 500 ? 'server_error' : 'request_failed');
}

export function normalizeErrorResponse(status, value, requestId) {
  if (Number(status) < 400 || !value || typeof value !== 'object' || !Object.hasOwn(value, 'error')) return value;
  const structured = value.error && typeof value.error === 'object' ? value.error : null;
  const errorCode = String(value.error_code || structured?.code || defaultErrorCode(status));
  const retryable = value.retryable ?? structured?.retryable ?? RETRYABLE_STATUSES.has(Number(status));
  return {
    ...value,
    error_code:errorCode,
    retryable:Boolean(retryable),
    ...(requestId ? { request_id:String(requestId) } : {}),
  };
}
