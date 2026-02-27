// Response Caching Layer
import { CacheConfig, CacheEntry, CacheKeyOptions } from './types/cache';
import { metrics } from './metrics';

// Default cacheable status codes
const DEFAULT_CACHEABLE_STATUS_CODES = [
  200, // OK
  203, // Non-Authoritative Information
  204, // No Content
  206, // Partial Content
  300, // Multiple Choices
  301, // Moved Permanently
  404, // Not Found
  405, // Method Not Allowed
  410, // Gone
  414, // URI Too Long
  501  // Not Implemented
];

export class CacheManager {
  constructor(private kvNamespace?: KVNamespace) {}

  /**
   * Generate a cache key based on request details
   */
  generateCacheKey(options: CacheKeyOptions): string {
    const { method, url, varyBy, headers, hmacUser } = options;
    
    // Start with method and URL
    const parts = [method, url];
    
    // Add HMAC user for per-user caching
    if (hmacUser) {
      parts.push(`user:${hmacUser}`);
    }
    
    // Add vary-by headers
    if (varyBy && varyBy.length > 0) {
      const headerParts = varyBy
        .map(header => `${header}:${headers.get(header) || ''}`)
        .sort()
        .join('|');
      parts.push(headerParts);
    }
    
    return parts.join('::');
  }

  /**
   * Check if response is cacheable based on status code and config
   */
  isCacheable(
    statusCode: number,
    config: CacheConfig,
    cacheControl?: string | null
  ): boolean {
    // Respect Cache-Control: no-store, no-cache, private
    if (config.respectCacheControl && cacheControl) {
      const directives = cacheControl.toLowerCase();
      if (
        directives.includes('no-store') ||
        directives.includes('no-cache') ||
        directives.includes('private')
      ) {
        return false;
      }
    }
    
    // Check if status code is cacheable
    const cacheableStatusCodes = config.cacheableStatusCodes || DEFAULT_CACHEABLE_STATUS_CODES;
    return cacheableStatusCodes.includes(statusCode);
  }

  /**
   * Parse Cache-Control header to extract TTL
   */
  parseCacheControlTTL(cacheControl: string | null, defaultTTL: number): number {
    if (!cacheControl) {
      return defaultTTL;
    }
    
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      return parseInt(maxAgeMatch[1], 10);
    }
    
    const sMaxAgeMatch = cacheControl.match(/s-maxage=(\d+)/i);
    if (sMaxAgeMatch) {
      return parseInt(sMaxAgeMatch[1], 10);
    }
    
    return defaultTTL;
  }

  /**
   * Get cached response from KV
   */
  async get(cacheKey: string): Promise<CacheEntry | null> {
    if (!this.kvNamespace) {
      return null;
    }
    
    try {
      const cached = await this.kvNamespace.get(cacheKey, 'text');
      if (!cached) {
        return null;
      }
      
      const entry: CacheEntry = JSON.parse(cached);
      
      // Check if expired
      if (Date.now() > entry.expiresAt) {
        // Check if stale-while-revalidate applies
        const staleAge = Date.now() - entry.expiresAt;
        const config = entry.response.headers['x-cache-config'];
        
        if (config) {
          const parsedConfig = JSON.parse(config);
          const swr = parsedConfig.staleWhileRevalidate || 0;
          
          if (staleAge <= swr * 1000) {
            // Return stale content, let caller know it needs revalidation
            return { ...entry, stale: true } as any;
          }
        }
        
        // Expired and no stale-while-revalidate
        await this.delete(cacheKey);
        return null;
      }
      
      return entry;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Store response in cache
   */
  async set(
    cacheKey: string,
    response: Response,
    config: CacheConfig,
    route: string
  ): Promise<void> {
    if (!this.kvNamespace) {
      return;
    }
    
    try {
      // Read response body
      const body = await response.text();
      
      // Determine TTL
      const cacheControl = response.headers.get('Cache-Control');
      let ttl = config.ttl;
      
      if (config.respectCacheControl && cacheControl) {
        ttl = this.parseCacheControlTTL(cacheControl, config.ttl);
      }
      
      // Create cache entry
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      
      // Add cache config to headers for stale-while-revalidate
      headers['x-cache-config'] = JSON.stringify({
        staleWhileRevalidate: config.staleWhileRevalidate || 0
      });
      
      const entry: CacheEntry = {
        response: {
          status: response.status,
          statusText: response.statusText,
          headers,
          body
        },
        cachedAt: Date.now(),
        expiresAt: Date.now() + ttl * 1000,
        route,
        cacheKey
      };
      
      // Store in KV with TTL
      await this.kvNamespace.put(
        cacheKey,
        JSON.stringify(entry),
        { expirationTtl: ttl + (config.staleWhileRevalidate || 0) }
      );
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  /**
   * Delete cached entry
   */
  async delete(cacheKey: string): Promise<void> {
    if (!this.kvNamespace) {
      return;
    }
    
    try {
      await this.kvNamespace.delete(cacheKey);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  /**
   * Invalidate cache by prefix (for a specific route)
   */
  async invalidateByPrefix(prefix: string): Promise<number> {
    if (!this.kvNamespace) {
      return 0;
    }
    
    try {
      let count = 0;
      let cursor: string | undefined;
      
      do {
        const list = await this.kvNamespace.list({ prefix, cursor });
        
        for (const key of list.keys) {
          await this.kvNamespace.delete(key.name);
          count++;
        }
        
        cursor = list.list_complete ? undefined : (list as any).cursor;
      } while (cursor);
      
      return count;
    } catch (error) {
      console.error('Cache invalidate error:', error);
      return 0;
    }
  }

  /**
   * Convert cached entry back to Response object
   */
  createResponseFromCache(entry: CacheEntry, stale: boolean = false): Response {
    const headers = new Headers(entry.response.headers);
    headers.set('X-Cache', 'HIT');
    headers.set('X-Cache-Date', new Date(entry.cachedAt).toISOString());
    
    if (stale) {
      headers.set('X-Cache-Status', 'STALE');
    }
    
    return new Response(entry.response.body, {
      status: entry.response.status,
      statusText: entry.response.statusText,
      headers
    });
  }
}

/**
 * Check if request should bypass cache
 */
export function shouldBypassCache(
  request: Request,
  config: CacheConfig
): boolean {
  const bypassHeader = config.bypassHeader || 'X-No-Cache';
  return request.headers.has(bypassHeader);
}
