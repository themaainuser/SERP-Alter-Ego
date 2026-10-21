/** Small in-memory TTL + LRU cache. */
interface Entry<V> {
  value: V;
  expires: number;
}

export class TtlCache<V = unknown> {
  private readonly max: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;

  constructor({ max = 200, now = Date.now }: { max?: number; now?: () => number } = {}) {
    this.max = max;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry || entry.expires <= this.now()) {
      if (entry) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}
