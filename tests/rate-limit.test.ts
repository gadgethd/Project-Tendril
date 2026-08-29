import { describe, expect, it } from 'vitest';
import { BoundedRateLimiter } from '../src/security/rate-limit.js';

describe('BoundedRateLimiter', () => {
  it('resets a peer after the fixed window and on explicit authentication success', () => {
    let now = 1_000;
    const limiter = new BoundedRateLimiter({ limit: 2, windowMs: 100, maxKeys: 4, now: () => now });
    expect(limiter.attempt('peer').allowed).toBe(true);
    expect(limiter.attempt('peer').allowed).toBe(true);
    expect(limiter.attempt('peer').allowed).toBe(false);
    now += 100;
    expect(limiter.attempt('peer').allowed).toBe(true);
    limiter.reset('peer');
    expect(limiter.attempt('peer').allowed).toBe(true);
  });

  it('never allocates more peer buckets than its configured bound', () => {
    const limiter = new BoundedRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (let index = 0; index < 10_000; index += 1) limiter.attempt(`peer-${index}`);
    expect(limiter.trackedKeyCount()).toBe(3);
    expect(limiter.attempt('overflow-peer').allowed).toBe(false);
  });
});
