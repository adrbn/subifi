// Tiny in-memory token bucket rate limiter keyed on a client identifier
// (typically an IP address). Resets on cold start. Sufficient to deter casual
// abuse of the transcription endpoint without pulling in Redis.

type Bucket = { tokens: number; updatedAt: number };

const CAPACITY = 10; // max requests in the burst window
const WINDOW_MS = 60 * 1000; // 1 minute refill window

const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string): {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
} {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: CAPACITY, updatedAt: now };

  // Refill proportionally to time elapsed.
  const elapsed = now - bucket.updatedAt;
  const refill = (elapsed / WINDOW_MS) * CAPACITY;
  const tokens = Math.min(CAPACITY, bucket.tokens + refill);

  if (tokens < 1) {
    const retryAfterMs = Math.ceil(((1 - tokens) / CAPACITY) * WINDOW_MS);
    buckets.set(key, { tokens, updatedAt: now });
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  const next = { tokens: tokens - 1, updatedAt: now };
  buckets.set(key, next);
  return {
    allowed: true,
    remaining: Math.floor(next.tokens),
    retryAfterMs: 0,
  };
}

export function clientKeyFromRequest(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}
