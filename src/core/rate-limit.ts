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

  constructor(
    private readonly windowSeconds: number,
    private readonly maxMessages: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitResult {
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
}
