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
    // Fill cache to 50, advancing time between each to ensure distinct timestamps
    for (let i = 0; i < 50; i++) {
      cache.set(`entry-${i}`, makeSpec(`event-${i}`));
      jest.advanceTimersByTime(1);
    }

    // Access entry-0 to make it recently used
    expect(cache.get("entry-0")).toBeDefined();
    jest.advanceTimersByTime(1);

    // Add 51st entry - should evict LRU (entry-1, since entry-0 was recently accessed)
    cache.set("entry-50", makeSpec("event-50"));

    // entry-1 should be evicted (oldest lastAccessed that wasn't touched by get)
    expect(cache.get("entry-1")).toBeUndefined();

    // entry-0 should still be present (was recently accessed)
    expect(cache.get("entry-0")).toBeDefined();

    // entry-50 should be present
    expect(cache.get("entry-50")).toBeDefined();
  });

  test("global sweep runs every 50 operations", () => {
    // Add an entry that will be expired
    cache.set("will-expire", makeSpec("expire"));
    jest.advanceTimersByTime(61_000);

    // Perform 49 operations (the first set counts as 1, so we need 49 more)
    for (let i = 0; i < 49; i++) {
      cache.set(`filler-${i}`, makeSpec(`filler-${i}`));
    }

    // The expired entry might still be "in" storage but not yet swept
    // On the 50th operation the sweep should run and remove it
    cache.set("trigger-sweep", makeSpec("trigger"));

    expect(cache.get("will-expire")).toBeUndefined();
  });

  test("flush clears all entries", () => {
    cache.set("a", makeSpec("a"));
    cache.set("b", makeSpec("b"));

    cache.flush();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  test("key format uses apiKey:streamId:eventName", () => {
    const key = AvoEventSpecCache.makeKey("myApi", "stream1", "click");
    expect(key).toBe("myApi:stream1:click");
  });
});
