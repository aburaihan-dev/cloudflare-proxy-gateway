// Cache types and interfaces

export interface CacheConfig {
  ttl: number; // Time to live in seconds
  varyBy?: string[]; // Headers to include in cache key (e.g., ['Accept-Language', 'Authorization'])
  bypassHeader?: string; // Header to bypass cache (default: 'X-No-Cache')
  staleWhileRevalidate?: number; // Seconds to serve stale content while revalidating
  cacheableStatusCodes?: number[]; // Status codes to cache (default: [200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501])
  respectCacheControl?: boolean; // Respect Cache-Control headers from backend (default: true)
}

export interface CacheEntry {
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  };
  cachedAt: number;
  expiresAt: number;
  route: string;
  cacheKey: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  size: number;
}

export interface CacheKeyOptions {
  method: string;
  url: string;
  varyBy?: string[];
  headers: Headers;
  hmacUser?: string; // For per-user caching with HMAC
}
