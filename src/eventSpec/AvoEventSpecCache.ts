import { EventSpecResponse } from "./AvoEventSpecFetchTypes";

interface CacheEntry {
  value: EventSpecResponse;
  timestamp: number;
  eventCount: number;
  lastAccessed: number;
}

const MAX_EVENT_COUNT = 50;
const TTL_MS = 60_000;

export class AvoEventSpecCache {
  private cache: Map<string, CacheEntry> = new Map();
  private globalEventCount = 0;

  static makeKey(apiKey: string, streamId: string, eventName: string): string {
    return `${apiKey}:${streamId}:${eventName}`;
  }

  /**
   * Returns the cached EventSpecResponse, or undefined on cache miss.
   * A cached response with eventSpec: null means "no spec exists for this event".
   */
  get(key: string): EventSpecResponse | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    // TTL check
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }

    // Per-entry access count eviction
    entry.eventCount++;
    if (entry.eventCount >= MAX_EVENT_COUNT) {
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
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(key);
      return false;
    }
    if (entry.eventCount >= MAX_EVENT_COUNT) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, value: EventSpecResponse): void {
    this.globalEventCount++;

    // Global rotation: evict LRU entry every MAX_EVENT_COUNT operations
    if (this.globalEventCount >= MAX_EVENT_COUNT) {
      this.evictLRU();
      this.globalEventCount = 0;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
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
