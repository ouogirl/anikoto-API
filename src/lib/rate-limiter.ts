/**
 * Lightweight in-memory rate limiter with sliding window counter.
 * Designed to protect expensive scraping and proxy endpoints against abusive flooding
 * without impacting legitimate personal browsing or streaming.
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

class MemoryRateLimiter {
  private records = new Map<string, RateLimitRecord>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxEntries: number;
  private lastCleanup = Date.now();

  constructor(options: { windowMs?: number; maxRequests: number; maxEntries?: number }) {
    this.windowMs = options.windowMs ?? 60_000; // default 1 minute
    this.maxRequests = options.maxRequests;
    this.maxEntries = options.maxEntries ?? 5000;
  }

  public check(key: string): { allowed: boolean; remaining: number; resetAfter: number } {
    const now = Date.now();

    // Periodic cleanup of expired entries
    if (now - this.lastCleanup > 30_000) {
      this.cleanup(now);
      this.lastCleanup = now;
    }

    // Guard against memory exhaustion if attacker creates endless random IPs
    if (this.records.size > this.maxEntries) {
      this.cleanup(now);
      if (this.records.size > this.maxEntries) {
        this.records.clear();
      }
    }

    let record = this.records.get(key);

    if (!record || now >= record.resetAt) {
      record = { count: 1, resetAt: now + this.windowMs };
      this.records.set(key, record);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAfter: Math.ceil(this.windowMs / 1000),
      };
    }

    if (record.count >= this.maxRequests) {
      const resetAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        resetAfter,
      };
    }

    record.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - record.count,
      resetAfter: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
  }

  private cleanup(now: number): void {
    for (const [key, record] of this.records.entries()) {
      if (now >= record.resetAt) {
        this.records.delete(key);
      }
    }
  }
}

// 240 requests/min for proxy (sufficient for full HLS segment fetching + seeking)
export const proxyLimiter = new MemoryRateLimiter({
  windowMs: 60_000,
  maxRequests: 240,
});

// 60 requests/min for search and filter (prevents heavy scraping floods)
export const searchLimiter = new MemoryRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
});

/**
 * Extract client IP from standard proxy headers or fallback.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') || '127.0.0.1';
}
