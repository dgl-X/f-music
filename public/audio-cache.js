const MiB = 1024 * 1024;

// Session-only cache. Object URLs are private to the tab and never reach HTTP caches.
export class AudioMemoryCache {
  constructor({ fetcher = fetch, createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL, maxTrackBytes = 64 * MiB, maxBytes = 128 * MiB } = {}) {
    this.fetcher = fetcher;
    this.createUrl = createUrl;
    this.revokeUrl = revokeUrl;
    this.maxTrackBytes = maxTrackBytes;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
    this.pinned = '';
  }

  get(trackId) {
    const entry = this.entries.get(trackId);
    if (!entry) return null;
    this.entries.delete(trackId);
    this.entries.set(trackId, entry);
    return entry.url;
  }

  pin(trackId) { this.pinned = trackId; }

  async load(trackId, source, signal) {
    if (this.get(trackId)) return this.get(trackId);
    if (this.pending.has(trackId)) return this.pending.get(trackId);
    const job = this.download(trackId, source, signal);
    this.pending.set(trackId, job);
    try { return await job; } finally { if (this.pending.get(trackId) === job) this.pending.delete(trackId); }
  }

  async download(trackId, source, signal) {
    const response = await this.fetcher(source, { credentials: 'same-origin', cache: 'no-store', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0 || length > this.maxTrackBytes) { await response.body?.cancel(); return null; }
    const blob = await response.blob();
    if (signal?.aborted || !blob.size || blob.size > this.maxTrackBytes) return null;
    if (this.entries.has(trackId)) return this.get(trackId);
    const url = this.createUrl(blob);
    this.entries.set(trackId, { url, bytes: blob.size });
    this.bytes += blob.size;
    this.evict();
    return this.entries.get(trackId)?.url ?? null;
  }

  evict() {
    for (const [id, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (id === this.pinned) continue;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
      this.revokeUrl(entry.url);
    }
  }

  delete(trackId) {
    const entry = this.entries.get(trackId);
    if (!entry) return;
    this.entries.delete(trackId);
    this.bytes -= entry.bytes;
    this.revokeUrl(entry.url);
  }

  clear() {
    for (const entry of this.entries.values()) this.revokeUrl(entry.url);
    this.entries.clear();
    this.bytes = 0;
    this.pinned = '';
  }
}
