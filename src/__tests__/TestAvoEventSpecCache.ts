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
    // Use a fresh cache and fill it carefully.
    // Global rotation fires at every 50th set, so add 50 entries first
    // (the 50th set evicts LRU entry-0).
    for (let i = 0; i < 50; i++) {
      cache.set(`entry-${i}`, makeSpec(`event-${i}`));
      jest.advanceTimersByTime(1);
    }

    // entry-0 was evicted by global rotation at the 50th set
    expect(cache.get("entry-0")).toBeUndefined();

    // Access entry-1 to make it recently used
    expect(cache.get("entry-1")).toBeDefined();
    jest.advanceTimersByTime(1);

    // Add entry-50 — now 50 entries again, size-cap eviction kicks in for the 51st
    // Add entry-51 to push over 50
    cache.set("entry-50", makeSpec("event-50"));
    jest.advanceTimersByTime(1);
    cache.set("entry-51", makeSpec("event-51"));

    // entry-2 should be evicted (oldest lastAccessed that wasn't touched)
    expect(cache.get("entry-2")).toBeUndefined();

    // entry-1 should still be present (was recently accessed via get)
    expect(cache.get("entry-1")).toBeDefined();

    // entry-51 should be present
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
