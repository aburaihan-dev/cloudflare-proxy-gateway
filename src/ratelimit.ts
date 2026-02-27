/**
 * Rate Limiting Module
 * 
 * Strategy:
 * - In-memory Map for fast lookups (per-isolate, resets on cold start)
 * - Fixed window algorithm (simple, efficient for edge computing)
 * - Per-IP baseline rate limiting
 * - Per-route multipliers
 * 
 * Responses:
 * - Rate limited: 429 with Retry-After header
 */

import { ProxyConfig, Route } from './config';

interface RateLimitWindow {
  count: number;
  windowStart: number; // Unix timestamp in seconds
}

// In-memory storage (per-isolate, ephemeral)
const rateLimitStore = new Map<string, RateLimitWindow>();

// Cleanup configuration to prevent memory leaks
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60000; // 1 minute (reduced from 10 minutes)
const MAX_ENTRIES = 10000; // Hard limit to prevent unbounded growth

/**
 * Generate rate limit key based on IP and optional route prefix
 */
function getRateLimitKey(ip: string, routePrefix?: string): string {
  if (routePrefix) {
    return `${ip}:${routePrefix}`;
  }
  return ip;
}

/**
 * Calculate current window start time (Unix timestamp in seconds)
 */
function getCurrentWindow(windowSeconds: number): number {
  return Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
}

/**
 * Clean up old entries from the rate limit store
 * Includes both time-based cleanup and size-based eviction
 */
function cleanupOldEntries(windowSeconds: number): void {
  const now = Date.now();
  
  // Only cleanup every CLEANUP_INTERVAL
  if (now - lastCleanup < CLEANUP_INTERVAL) {
    // Emergency cleanup if we hit max entries
    if (rateLimitStore.size >= MAX_ENTRIES) {
      performEmergencyCleanup();
    }
    return;
  }
  
  const currentWindow = getCurrentWindow(windowSeconds);
  const entriesToDelete: string[] = [];
  
  // Find entries older than current window
  for (const [key, window] of rateLimitStore.entries()) {
    if (window.windowStart < currentWindow) {
      entriesToDelete.push(key);
    }
  }
  
  // Delete old entries
  for (const key of entriesToDelete) {
    rateLimitStore.delete(key);
  }
  
  // If still too large, perform emergency cleanup
  if (rateLimitStore.size >= MAX_ENTRIES) {
    performEmergencyCleanup();
  }
  
  lastCleanup = now;
}

/**
 * Emergency cleanup when max entries exceeded
 * Removes oldest 25% of entries
 */
function performEmergencyCleanup(): void {
  const entries = Array.from(rateLimitStore.entries());
  // Sort by window start time (oldest first)
  entries.sort((a, b) => a[1].windowStart - b[1].windowStart);
  
  // Remove oldest 25%
  const toRemove = Math.floor(entries.length * 0.25);
  for (let i = 0; i < toRemove; i++) {
    rateLimitStore.delete(entries[i][0]);
  }
  
  console.warn(`Emergency rate limit cleanup: removed ${toRemove} entries, ${rateLimitStore.size} remaining`);
}

/**
 * Check if request is within rate limit
 * 
 * @param ip - Client IP address
 * @param config - Proxy configuration with rate limit settings
 * @param matchedRoute - Matched route (optional, for per-route multipliers)
 * @returns Object with allowed status and retry time if blocked
 */
export function checkRateLimit(
  ip: string,
  config: ProxyConfig,
  matchedRoute?: Route
): { allowed: boolean; retryAfter?: number; limit?: number; current?: number } {
  // If rate limiting is disabled, allow all
  if (!config.rateLimit || !config.rateLimit.enabled) {
    return { allowed: true };
  }
  
  const { requestsPerWindow, windowSeconds } = config.rateLimit;
  
  // Periodic cleanup of old entries
  cleanupOldEntries(windowSeconds);
  
  // Calculate effective limit based on route multiplier
  let effectiveLimit = requestsPerWindow;
  
  // Apply route-specific multiplier
  if (matchedRoute?.rateLimitMultiplier) {
    effectiveLimit = Math.floor(effectiveLimit * matchedRoute.rateLimitMultiplier);
  }
  
  // Get current window
  const currentWindow = getCurrentWindow(windowSeconds);
  
  // Generate key (per-IP, optionally scoped by route)
  const key = getRateLimitKey(ip, matchedRoute?.prefix);
  
  // Get or create window entry
  let windowEntry = rateLimitStore.get(key);
  
  // If no entry or window has rotated, create new window
  if (!windowEntry || windowEntry.windowStart < currentWindow) {
    windowEntry = {
      count: 0,
      windowStart: currentWindow
    };
    rateLimitStore.set(key, windowEntry);
  }
  
  // Check if limit exceeded
  if (windowEntry.count >= effectiveLimit) {
    const retryAfter = (currentWindow + windowSeconds) - Math.floor(Date.now() / 1000);
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1), // At least 1 second
      limit: effectiveLimit,
      current: windowEntry.count
    };
  }
  
  // Increment counter
  windowEntry.count++;
  
  return {
    allowed: true,
    limit: effectiveLimit,
    current: windowEntry.count
  };
}

/**
 * Get current rate limit status for an IP (for monitoring/debugging)
 */
export function getRateLimitStatus(
  ip: string,
  config: ProxyConfig,
  matchedRoute?: Route
): { current: number; limit: number; windowStart: number } | null {
  if (!config.rateLimit || !config.rateLimit.enabled) {
    return null;
  }
  
  const key = getRateLimitKey(ip, matchedRoute?.prefix);
  const windowEntry = rateLimitStore.get(key);
  
  if (!windowEntry) {
    return {
      current: 0,
      limit: config.rateLimit.requestsPerWindow,
      windowStart: getCurrentWindow(config.rateLimit.windowSeconds)
    };
  }
  
  return {
    current: windowEntry.count,
    limit: config.rateLimit.requestsPerWindow,
    windowStart: windowEntry.windowStart
  };
}

/**
 * Clear all rate limit counters (for testing or admin operations)
 */
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}
