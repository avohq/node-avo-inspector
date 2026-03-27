import { AvoEventSpecCache } from "../eventSpec/AvoEventSpecCache";
import { EventSpecResponse } from "../eventSpec/AvoEventSpecFetchTypes";

function makeSpec(eventName: string): EventSpecResponse {
  return {
    eventSpec: {
      eventName,
      properties: [{ propertyName: "prop1", propertyType: "string" }],
    },
    metadata: {
      schemaId: "schema1",
      branchId: "branch1",
      latestActionId: "action1",
      sourceId: "source1",
    },
  };
}

describe("AvoEventSpecCache", () => {
  let cache: AvoEventSpecCache;

  beforeEach(() => {
    cache = new AvoEventSpecCache();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns undefined for cache miss", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  test("stores and retrieves a value", () => {
    const spec = makeSpec("click");
    cache.set("key1", spec);
    expect(cache.get("key1")).toEqual(spec);
  });

  test("stores and retrieves null responses", () => {
    const nullSpec: EventSpecResponse = {
      eventSpec: null,
      metadata: {
        schemaId: "s1",
        branchId: "b1",
        latestActionId: "a1",
        sourceId: "src1",
      },
    };
    cache.set("null-key", nullSpec);
    expect(cache.get("null-key")).toEqual(nullSpec);
  });

  test("TTL eviction: entries older than 60s removed on next sweep", () => {
    cache.set("old-key", makeSpec("old"));

    // Advance time by 61 seconds
    jest.advanceTimersByTime(61_000);

    // Trigger sweep by performing enough operations
    for (let i = 0; i < 50; i++) {
      cache.set(`sweep-${i}`, makeSpec(`sweep-${i}`));
    }

    expect(cache.get("old-key")).toBeUndefined();
  });

  test("per-entry eviction: entries retrieved 50+ times evicted on next get", () => {
    cache.set("hot-key", makeSpec("hot"));

    // Access 49 times - should still be present
    for (let i = 0; i < 49; i++) {
      expect(cache.get("hot-key")).toBeDefined();
    }

    // The 50th access should trigger eviction
    expect(cache.get("hot-key")).toBeUndefined();
  });

  test("LRU eviction when size > 50", () => {
    // Fill cache with 50 entries. Each set() creates an entry with
    // lastAccessed = Date.now(). We advance the fake clock by 1ms between
    // sets so every entry has a distinct timestamp.
    // The 50th set triggers evictLRU(), which removes the entry with the
    // oldest lastAccessed — that is entry-0 (set at t=0).
    for (let i = 0; i < 50; i++) {
      cache.set(`entry-${i}`, makeSpec(`event-${i}`));
      jest.advanceTimersByTime(1);
    }

    // entry-0 was the oldest when evictLRU() fired on the 50th set,
    // so it should have been removed.
    expect(cache.get("entry-0")).toBeUndefined();

    // Touch entry-1 via get() — this updates its lastAccessed to "now",
    // making it the most-recently-accessed entry and protecting it from
    // the next eviction.
    expect(cache.get("entry-1")).toBeDefined();
    jest.advanceTimersByTime(1);

    // Add two more entries to push the cache over 50 again.
    // Each set that crosses the 50-entry threshold triggers evictLRU().
    cache.set("entry-50", makeSpec("event-50"));
    jest.advanceTimersByTime(1);
    cache.set("entry-51", makeSpec("event-51"));

    // entry-2 was never touched after its initial set(), so it had the
    // oldest lastAccessed among remaining entries — evictLRU() removes it.
    expect(cache.get("entry-2")).toBeUndefined();

    // entry-1 survives because get() above refreshed its lastAccessed,
    // so it was NOT the oldest entry when eviction fired.
    expect(cache.get("entry-1")).toBeDefined();

    // entry-51 was just inserted, so it is definitely still present.
    expect(cache.get("entry-51")).toBeDefined();
  });

  test("global rotation evicts LRU entry every 50 operations", () => {
    // Add entries with distinct timestamps
    for (let i = 0; i < 49; i++) {
      cache.set(`entry-${i}`, makeSpec(`event-${i}`));
      jest.advanceTimersByTime(1);
    }

    // The 50th set triggers global rotation, evicting the LRU entry (entry-0)
    cache.set("entry-49", makeSpec("event-49"));

    expect(cache.get("entry-0")).toBeUndefined();
    expect(cache.get("entry-49")).toBeDefined();
  });

  test("flush on empty cache is a no-op", () => {
    // Just verify no crash
    cache.flush();
    expect(cache.get("anything")).toBeUndefined();
  });

  test("flush clears all entries", () => {
    cache.set("a", makeSpec("a"));
    cache.set("b", makeSpec("b"));

    cache.flush();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  test("key format uses null-byte delimiter", () => {
    const key = AvoEventSpecCache.makeKey("myApi", "stream1", "click");
    expect(key).toBe("myApi\0stream1\0click");
  });

  describe("contains()", () => {
    test("returns true for a valid cached entry", () => {
      cache.set("k1", makeSpec("click"));
      expect(cache.contains("k1")).toBe(true);
    });

    test("returns false for a missing key", () => {
      expect(cache.contains("nonexistent")).toBe(false);
    });

    test("returns false after TTL expiry", () => {
      cache.set("ttl-key", makeSpec("click"));
      jest.advanceTimersByTime(61_000);
      expect(cache.contains("ttl-key")).toBe(false);
    });

    test("returns false after access count exhaustion", () => {
      cache.set("hot-key", makeSpec("hot"));

      // Access 49 times via get to increment eventCount to 49
      for (let i = 0; i < 49; i++) {
        cache.get("hot-key");
      }

      // eventCount is now 49; contains() checks >= 50, so still false at 49
      // but the 50th get() returned undefined and deleted the entry
      // Actually the 50th get increments to 50 and evicts, so after 49 gets
      // eventCount is 49. The next get (50th) increments to 50 and evicts.
      // contains() checks >= MAX_EVENT_COUNT without incrementing, so at 49 it's true.
      // We need one more get to push it to 50.
      expect(cache.get("hot-key")).toBeUndefined(); // 50th access evicts

      expect(cache.contains("hot-key")).toBe(false);
    });
  });

  describe("upsert/overwrite", () => {
    test("setting the same key twice overwrites the previous value", () => {
      const spec1 = makeSpec("first");
      const spec2 = makeSpec("second");

      cache.set("dup-key", spec1);
      expect(cache.get("dup-key")).toEqual(spec1);

      cache.set("dup-key", spec2);
      expect(cache.get("dup-key")).toEqual(spec2);
    });

    test("overwrite resets timestamp", () => {
      cache.set("ts-key", makeSpec("event"));

      // Advance time close to TTL
      jest.advanceTimersByTime(55_000);

      // Overwrite — should reset the timestamp
      cache.set("ts-key", makeSpec("event-v2"));

      // Advance another 10s (total 65s since first set, but only 10s since overwrite)
      jest.advanceTimersByTime(10_000);

      expect(cache.get("ts-key")).toBeDefined();
    });

    test("overwrite resets eventCount", () => {
      cache.set("count-key", makeSpec("event"));

      // Access 48 times to bring eventCount close to limit
      for (let i = 0; i < 48; i++) {
        cache.get("count-key");
      }

      // Overwrite — should reset eventCount to 0
      cache.set("count-key", makeSpec("event-v2"));

      // Should be able to access again without hitting the limit
      expect(cache.get("count-key")).toBeDefined();
      expect(cache.get("count-key")).toBeDefined();
    });
  });

  describe("makeKey delimiter collision", () => {
    test("makeKey with null-byte delimiter prevents colon collisions", () => {
      const key1 = AvoEventSpecCache.makeKey("a:b", "c", "d");
      const key2 = AvoEventSpecCache.makeKey("a", "b:c", "d");
      expect(key1).not.toBe(key2);
    });
  });
});
