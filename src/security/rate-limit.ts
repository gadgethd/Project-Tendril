interface Bucket {
  count: number;
  windowStartedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export class BoundedRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly overflow: Bucket = { count: 0, windowStartedAt: 0 };

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
      maxKeys: number;
      now?: () => number;
    },
  ) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new TypeError('Rate limit must be a positive integer');
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) throw new TypeError('Rate-limit window must be a positive integer');
    if (!Number.isSafeInteger(options.maxKeys) || options.maxKeys < 1) throw new TypeError('Rate-limit key bound must be a positive integer');
  }

  attempt(key: string): RateLimitDecision {
    const now = this.options.now?.() ?? Date.now();
    const boundedKey = key.slice(0, 128);
    let bucket = this.buckets.get(boundedKey);
    if (!bucket) {
      this.pruneExpired(now);
      if (this.buckets.size < this.options.maxKeys) {
        bucket = { count: 0, windowStartedAt: now };
        this.buckets.set(boundedKey, bucket);
      } else {
        bucket = this.overflow;
      }
    }
    if (now - bucket.windowStartedAt >= this.options.windowMs || now < bucket.windowStartedAt) {
      bucket.count = 0;
      bucket.windowStartedAt = now;
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= this.options.limit,
      retryAfterMs: Math.max(0, bucket.windowStartedAt + this.options.windowMs - now),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key.slice(0, 128));
  }

  trackedKeyCount(): number {
    return this.buckets.size;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= this.options.windowMs || now < bucket.windowStartedAt) {
        this.buckets.delete(key);
      }
    }
  }
}
