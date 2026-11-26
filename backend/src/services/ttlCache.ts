/**
 * A minimal in-process TTL cache, with no external dependency (no Redis,
 * no cache library) — appropriate for a single-instance API. Used by the
 * leaderboard endpoint (#16), whose aggregation scans every donation row
 * and gets more expensive as donation volume grows, but whose result
 * tolerates being a few seconds stale.
 *
 * Not shared across processes: if this API ever runs with more than one
 * instance behind a load balancer, each instance caches independently
 * (harmless here since it only shortens the window in which two
 * instances might disagree, no worse than a single instance racing two
 * requests).
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface PendingEntry<T> {
  generation: number;
  promise: Promise<T>;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, PendingEntry<T>>();
  private readonly generations = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys?: number,
    private readonly sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    const generation = this.generations.get(key) ?? 0;
    // Delete first so a re-set moves the key to the end of the insertion
    // order used by the bounded-eviction fallback below.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.generations.set(key, generation);
    this.enforceMaxKeys();
  }

  /**
   * Returns the cached value, or shares a single in-flight `compute` call
   * with every concurrent caller for the same key. A compute that began
   * before `clear()` cannot repopulate the cache afterwards.
   */
  async getOrSet(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const generation = this.generations.get(key) ?? 0;
    const pending = this.inFlight.get(key);
    if (pending && pending.generation === generation) {
      return pending.promise;
    }

    const promise = compute().then(
      (value) => {
        const current = this.inFlight.get(key);
        if (current && current.promise === promise) this.inFlight.delete(key);
        if ((this.generations.get(key) ?? 0) === generation) {
          this.set(key, value);
        }
        return value;
      },
      (error: unknown) => {
        const current = this.inFlight.get(key);
        if (current && current.promise === promise) this.inFlight.delete(key);
        throw error;
      },
    );

    this.inFlight.set(key, { generation, promise });
    return promise;
  }

  clear(): void {
    for (const key of this.store.keys()) {
      this.bumpGeneration(key);
    }
    for (const key of this.inFlight.keys()) {
      this.bumpGeneration(key);
    }
    this.store.clear();
    this.inFlight.clear();
  }

  /** Removes every expired entry, including keys nobody has read again. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Starts the periodic sweep. The timer is unref'd so it never keeps the process alive. */
  startSweeping(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
  }

  stopSweeping(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get size(): number {
    return this.store.size;
  }

  private bumpGeneration(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private enforceMaxKeys(): void {
    if (this.maxKeys === undefined || this.store.size <= this.maxKeys) return;
    this.sweep();
    while (this.store.size > this.maxKeys) {
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
  }
}
