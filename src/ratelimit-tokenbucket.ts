/**
 * Token Bucket Rate Limiting (Sprint 4)
 * 
 * Features:
 * - Token bucket algorithm for smoother rate limiting
 * - Configurable burst allowance
 * - Per-route and per-IP rate limiting
 * - Token refill based on time elapsed
 */

import { ProxyConfig, Route } from './config';

interface TokenBucket {
  tokens: number;
  lastRefill: number; // Unix timestamp in milliseconds
  capacity: number;
  refillRate: number; // Tokens per second
}

// In-memory token buckets (per-isolate)
const tokenBuckets = new Map<string, TokenBucket>();

// Cleanup old buckets periodically
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 600000; // 10 minutes
const BUCKET_EXPIRY = 3600000; // 1 hour

/**
 * Generate bucket key
 */
function getBucketKey(ip: string, routePrefix?: string): string {
  return routePrefix ? `${ip}:${routePrefix}` : ip;
}

/**
 * Cleanup expired buckets
 */
function cleanupExpiredBuckets(): void {
  const now = Date.now();
  
  if (now - lastCleanup < CLEANUP_INTERVAL) {
    return;
  }
  
  const expired: string[] = [];
  const cutoff = now - BUCKET_EXPIRY;
  
  tokenBuckets.forEach((bucket, key) => {
    if (bucket.lastRefill < cutoff) {
      expired.push(key);
    }
  });
  
  expired.forEach(key => tokenBuckets.delete(key));
  lastCleanup = now;
}

/**
 * Get or create token bucket
 */
function getOrCreateBucket(
  key: string,
  capacity: number,
  refillRate: number
): TokenBucket {
  let bucket = tokenBuckets.get(key);
  
  if (!bucket) {
    bucket = {
      tokens: capacity, // Start with full bucket
      lastRefill: Date.now(),
      capacity,
      refillRate
    };
    tokenBuckets.set(key, bucket);
  }
  
  return bucket;
}

/**
 * Refill tokens based on time elapsed
 */
function refillTokens(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  
  // Calculate tokens to add
  const tokensToAdd = elapsedSeconds * bucket.refillRate;
  
  // Add tokens but don't exceed capacity
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

/**
 * Token bucket rate limiting check
 */
export function checkTokenBucketRateLimit(
  ip: string,
  config: ProxyConfig,
  route?: Route
): {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
} {
  // Cleanup expired buckets periodically
  cleanupExpiredBuckets();
  
  if (!config.rateLimit || !config.rateLimit.enabled) {
    return {
      allowed: true,
      limit: Infinity,
      remaining: Infinity,
      retryAfter: 0
    };
  }
  
  // Calculate effective limit
  let baseRequestsPerWindow = config.rateLimit.requestsPerWindow;
  const windowSeconds = config.rateLimit.windowSeconds;
  
  // Apply route multiplier
  if (route?.rateLimitMultiplier) {
    baseRequestsPerWindow *= route.rateLimitMultiplier;
  }
  
  // Convert to tokens per second
  const tokensPerSecond = baseRequestsPerWindow / windowSeconds;
  const capacity = Math.ceil(baseRequestsPerWindow * 1.5); // 50% burst allowance
  
  // Get or create bucket
  const bucketKey = getBucketKey(ip, route?.prefix);
  const bucket = getOrCreateBucket(bucketKey, capacity, tokensPerSecond);
  
  // Refill tokens
  refillTokens(bucket);
  
  // Check if we have tokens available
  if (bucket.tokens >= 1) {
    // Consume one token
    bucket.tokens -= 1;
    
    return {
      allowed: true,
      limit: baseRequestsPerWindow,
      remaining: Math.floor(bucket.tokens),
      retryAfter: 0
    };
  }
  
  // Not enough tokens - calculate retry after
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfter = Math.ceil(tokensNeeded / tokensPerSecond);
  
  return {
    allowed: false,
    limit: baseRequestsPerWindow,
    remaining: 0,
    retryAfter
  };
}

/**
 * Get token bucket stats
 */
export function getTokenBucketStats(ip: string, routePrefix?: string): {
  tokens: number;
  capacity: number;
  refillRate: number;
} | null {
  const key = getBucketKey(ip, routePrefix);
  const bucket = tokenBuckets.get(key);
  
  if (!bucket) {
    return null;
  }
  
  // Refill before returning stats
  refillTokens(bucket);
  
  return {
    tokens: bucket.tokens,
    capacity: bucket.capacity,
    refillRate: bucket.refillRate
  };
}
