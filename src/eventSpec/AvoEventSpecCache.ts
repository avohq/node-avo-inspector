import { EventSpecResponse } from "./AvoEventSpecFetchTypes";

interface CacheEntry {
  value: EventSpecResponse;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
}

const MAX_ENTRIES = 50;
const TTL_MS = 60_000;
const MAX_ACCESS_COUNT = 50;
const SWEEP_INTERVAL = 50;

export class AvoEventSpecCache {
  private cache: Map<string, CacheEntry> = new Map();
  private operationCount = 0;

  static makeKey(apiKey: string, streamId: string, eventName: string): string {
    return `${apiKey}:${streamId}:${eventName}`;
  }

  get(key: string): EventSpecResponse | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) {
      return undefined;
    }

    // Per-entry eviction: evict after 50 accesses
    entry.accessCount++;
    if (entry.accessCount >= MAX_ACCESS_COUNT) {
      this.cache.delete(key);
      return undefined;
    }

    entry.lastAccessed = Date.now();
    return entry.value;
  }

  set(key: string, value: EventSpecResponse): void {
    this.operationCount++;

    // Global sweep every 50 operations
    if (this.operationCount % SWEEP_INTERVAL === 0) {
      this.sweep();
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
    });

    // LRU eviction when size > MAX_ENTRIES
    if (this.cache.size > MAX_ENTRIES) {
      this.evictLRU();
    }
  }

  flush(): void {
    this.cache.clear();
    this.operationCount = 0;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > TTL_MS) {
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
