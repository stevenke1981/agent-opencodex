export class ContinuationStore {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 21_600_000;
    this.entries = new Map();
  }

  get(id) {
    if (!this.enabled || !id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(id);
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return structuredClone(entry.value);
  }

  set(id, value) {
    if (!this.enabled || !id) return;
    this.entries.set(id, { createdAt: Date.now(), value: structuredClone(value) });
    this.prune();
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    this.prune();
    return this.entries.size;
  }
}
