export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimitService {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrunedAt = 0;

  constructor(
    private readonly windowSeconds: number,
    private readonly maxMessages: number,
    // Bounds memory for long-running processes: idle keys would otherwise stay in the
    // map forever. Counters are per process, so a multi-instance deployment enforces
    // the limit per instance rather than globally.
    private readonly maxBuckets = 10_000,
  ) {}

  check(key: string, now = Date.now()): RateLimitResult {
    // Sweep at most once per window so a flood of distinct keys cannot turn every
    // request into a full scan of the bucket map.
    if (this.buckets.size > this.maxBuckets && now - this.lastPrunedAt >= this.windowSeconds * 1000) {
      this.lastPrunedAt = now;
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + this.windowSeconds * 1000;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxMessages - 1, resetAt };
    }

    if (existing.count >= this.maxMessages) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;
    return { allowed: true, remaining: this.maxMessages - existing.count, resetAt: existing.resetAt };
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
