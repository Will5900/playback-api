//
// Tiny in-memory TTL cache. Used to dampen addon storms — if 5 catalogs or
// 12 addons all answer the same search, we don't want to re-fetch on every
// poll from iOS.
//

type Entry<T> = { v: T; expires: number };

export class TTLCache<T> {
  private store = new Map<string, Entry<T>>();
  constructor(private defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, { v: value, expires: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  async memoize(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const fresh = await fn();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
}
