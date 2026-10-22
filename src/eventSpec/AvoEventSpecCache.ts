import { EventSpecCoordinates, EventSpecResponse } from "./AvoEventSpecFetchTypes";
import { normalizeOption } from "../utils";

interface CacheEntry {
  value: EventSpecResponse | null;
  timestamp: number;
  ttlMs: number;
  eventCount: number;
  lastAccessed: number;
}

const MAX_EVENT_COUNT = 50;

/**
 * The key of a fetch with gateway coordinates, or undefined without any: "\0" and a JSON
 * array of `parts` then both normalized coordinates (null for an absent one). JSON encodes
 * every part on its own, so no event name can make it equal another key; and as the
 * apiKey never contains NUL, no key without coordinates starts with "\0".
 * Shared by the spec cache key and the fetcher's in-flight dedupe key.
 */
export const coordinatesKey = (parts: string[], coordinates?: EventSpecCoordinates): string | undefined => {
  const { originHint, outputReference } = normalizeCoordinates(coordinates);
  if (originHint === undefined && outputReference === undefined) {
    return undefined;
  }
  return "\0" + JSON.stringify([...parts, originHint ?? null, outputReference ?? null]);
};

/** Trims each coordinate and drops a blank or non-string one. */
export const normalizeCoordinates = (coordinates?: EventSpecCoordinates): EventSpecCoordinates => {
  const result: EventSpecCoordinates = {};
  if (coordinates === null || typeof coordinates !== "object") {
    return result;
  }
  const originHint = normalizeOption(coordinates.originHint);
  const outputReference = normalizeOption(coordinates.outputReference);
  if (originHint !== undefined) {
    result.originHint = originHint;
  }
  if (outputReference !== undefined) {
    result.outputReference = outputReference;
  }
  return result;
};
const TTL_MS = 60_000;
/** TTL of a fetch that failed other than with a 404, so a blip skips validation only briefly. */
export const TRANSIENT_FAILURE_TTL_MS = 5_000;

export class AvoEventSpecCache {
  private cache: Map<string, CacheEntry> = new Map();
  private globalEventCount = 0;

  /**
   * The key of one spec. Gateway coordinates are part of it, so a gateway-input spec and an
   * output spec for the same event name never share an entry; without coordinates the key
   * is the plain `apiKey\0streamId\0eventName`.
   */
  static makeKey(
    apiKey: string,
    streamId: string,
    eventName: string,
    coordinates?: EventSpecCoordinates
  ): string {
    return coordinatesKey([apiKey, streamId, eventName], coordinates) ?? `${apiKey}\0${streamId}\0${eventName}`;
  }

  /**
   * Returns the cached EventSpecResponse, or undefined on cache miss.
   * A cached response with eventSpec: null means "no spec exists for this event";
   * a cached null means the fetch failed (such as a 404), so the event is not validated.
   */
  get(key: string): EventSpecResponse | null | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    // TTL check
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Per-entry access count eviction, which refreshes a spec after MAX_EVENT_COUNT uses.
    // A cached failure has nothing to refresh: it stays until its TTL.
    entry.eventCount++;
    if (entry.value !== null && entry.eventCount >= MAX_EVENT_COUNT) {
      this.cache.delete(key);
      return undefined;
    }

    entry.lastAccessed = Date.now();
    return entry.value;
  }

  /**
   * Returns true if the key exists in the cache and has not expired.
   */
  contains(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return false;
    }
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    if (entry.value !== null && entry.eventCount >= MAX_EVENT_COUNT) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Stores a fetched spec, or null for a failed fetch. A spec is kept until its TTL or
   * MAX_EVENT_COUNT uses; a null until its TTL only. `ttlMs` defaults to 60 s; a transient
   * failure passes TRANSIENT_FAILURE_TTL_MS.
   */
  set(key: string, value: EventSpecResponse | null, ttlMs: number = TTL_MS): void {
    // Every track sharing one fetch stores its response: only the first store counts, or a
    // burst of such tracks would rotate unrelated entries out of the cache.
    const existing = this.cache.get(key);
    if (existing !== undefined && existing.value === value) {
      return;
    }
    this.globalEventCount++;

    // Global rotation: evict LRU entry every MAX_EVENT_COUNT operations
    if (this.globalEventCount >= MAX_EVENT_COUNT) {
      this.purgeExpired();
      this.evictLRU();
      this.globalEventCount = 0;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttlMs,
      eventCount: 0,
      lastAccessed: Date.now(),
    });

    // Size cap: evict oldest entries when exceeding max
    while (this.cache.size > MAX_EVENT_COUNT) {
      this.evictLRU();
    }
  }

  flush(): void {
    this.cache.clear();
    this.globalEventCount = 0;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
    }
  }
}
