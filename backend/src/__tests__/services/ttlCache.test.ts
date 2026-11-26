import { TtlCache } from "../../services/ttlCache";

describe("TtlCache", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns undefined for a key that was never set", () => {
    const cache = new TtlCache<number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a value that was set, before it expires", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("expires a value after its TTL elapses", () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);

    jest.advanceTimersByTime(1001);

    expect(cache.get("a")).toBeUndefined();
  });

  it("does not expire a value exactly at the TTL boundary minus a moment", () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);

    jest.advanceTimersByTime(999);

    expect(cache.get("a")).toBe(42);
  });

  it("getOrSet computes and caches on a miss", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(7);

    const result = await cache.getOrSet("a", compute);

    expect(result).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("getOrSet returns the cached value without recomputing on a hit", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(7);

    await cache.getOrSet("a", compute);
    const second = await cache.getOrSet("a", compute);

    expect(second).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("getOrSet recomputes after the cached value expires", async () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    await cache.getOrSet("a", compute);
    jest.advanceTimersByTime(1001);
    const second = await cache.getOrSet("a", compute);

    expect(second).toBe(8);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys are independent of each other", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("clear removes every cached entry", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.clear();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("coalesces ten concurrent misses for one key into one compute", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(7);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.getOrSet("a", compute)),
    );

    expect(results).toEqual(Array(10).fill(7));
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("drops a failed in-flight compute so the next miss recomputes", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(9);

    await expect(cache.getOrSet("a", compute)).rejects.toThrow("db down");
    expect(await cache.getOrSet("a", compute)).toBe(9);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("sweeps idle expired entries without reading them", () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000, 10, 100);
    cache.set("idle", 1);

    jest.advanceTimersByTime(1001);

    expect(cache.size).toBe(1);
    expect(cache.sweep()).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("bounds the number of entries", () => {
    const cache = new TtlCache<number>(1000, 2);

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("does not let a compute straddling clear() repopulate the cache", async () => {
    const cache = new TtlCache<number>(1000);
    let release!: (value: number) => void;
    const compute = () => new Promise<number>((resolve) => (release = resolve));

    const inFlight = cache.getOrSet("profile", compute);
    cache.clear();
    release(42);

    expect(await inFlight).toBe(42);
    expect(cache.get("profile")).toBeUndefined();
  });
});
