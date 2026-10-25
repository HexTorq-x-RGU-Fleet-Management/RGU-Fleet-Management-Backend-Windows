// One short snapshot connection at a time, shared across viewer tabs.
export class PreviewCache {
  constructor({ ttl = 300000, now = Date.now } = {}) { this.ttl = ttl; this.now = now; this.values = new Map(); this.pending = new Map(); this.queue = Promise.resolve(); this.generation = 0; }
  get(key, capture) {
    const cached = this.values.get(key);
    if (cached && this.now() - cached.capturedAt < this.ttl) return Promise.resolve(cached);
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generation;
    const promise = this.queue.catch(() => {}).then(async () => {
      if (generation !== this.generation) throw new Error('Snapshot request cancelled.');
      const value = await capture();
      if (generation !== this.generation) throw new Error('Snapshot request cancelled.');
      this.values.set(key, value); if (this.values.size > 256) this.values.delete(this.values.keys().next().value);
      return value;
    });
    this.queue = promise; this.pending.set(key, promise);
    const clean = () => { if (this.pending.get(key) === promise) this.pending.delete(key); };
    promise.then(clean, clean); return promise;
  }
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
}
