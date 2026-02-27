// Configuration types and interfaces
import { SizeLimits } from './validation';
import { CacheConfig } from './types/cache';
import { CircuitBreakerConfig } from './types/circuitbreaker';
import { AuthFeatureConfig } from './types/auth';

export interface DeduplicationConfig {
  windowMs?: number; // Deduplication window in milliseconds (default: 5000)
}

// Feature configurations — all disabled by default, defined separately from routes
export interface FeaturesConfig {
  cache?: {
    enabled?: boolean; // default: false
    profiles: Record<string, CacheConfig>;
  };
  circuitBreaker?: {
    enabled?: boolean; // default: false
    profiles: Record<string, CircuitBreakerConfig>;
  };
  deduplication?: {
    enabled?: boolean; // default: false
    profiles: Record<string, DeduplicationConfig>;
  };
  sizeLimits?: {
    enabled?: boolean; // default: false
    default?: SizeLimits; // Global default (replaces globalSizeLimits)
    profiles: Record<string, SizeLimits>;
  };
  metrics?: {
    enabled?: boolean; // default: false
  };
  auth?: AuthFeatureConfig;
}

export interface Route {
  prefix: string;
  target: string;
  rateLimitMultiplier?: number; // Optional: Multiplier for rate limit (default: 1.0, e.g., 0.5 = half rate, 2.0 = double rate)
  cache?: string; // Profile name from features.cache.profiles
  circuitBreaker?: string; // Profile name from features.circuitBreaker.profiles
  deduplication?: string; // Profile name from features.deduplication.profiles
  sizeLimits?: string; // Profile name from features.sizeLimits.profiles
  auth?: string;       // Profile name from features.auth.profiles
}

export interface ProxyConfig {
  routes: Route[];
  allowedOrigins?: string[]; // Optional whitelist of allowed origins
  blockedOrigins?: string[]; // Optional blacklist of blocked origins/hostnames
  originChecksEnabled?: boolean; // Optional: Disable origin allowlist checks (default: true)
  turnstileSecretKey?: string; // Optional: Cloudflare Turnstile Secret Key
  rateLimit?: {
    enabled: boolean; // Enable rate limiting
    requestsPerWindow: number; // Number of requests allowed per window (e.g., 300)
    windowSeconds: number; // Time window in seconds (e.g., 300 = 5 minutes)
  };
  features?: FeaturesConfig; // Feature configurations (all disabled by default)
  version: string;
}

export interface CachedConfig {
  config: ProxyConfig;
  cachedAt: number;
  ttl: number;
}

export interface Env {
  PROXY_CONFIG: KVNamespace;
  PROXY_CACHE?: KVNamespace;      // Optional: KV namespace for response caching
  PROXY_AUTH_CACHE?: KVNamespace; // Optional: dedicated KV namespace for auth decision caching
  REQUEST_TIMEOUT?: string;
  CACHE_TTL?: string;
  ADMIN_KEY?: string;
  LOG_LEVEL?: string; // 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'NONE'
}

// In-memory cache (persists during worker execution)
let configCache: CachedConfig | null = null;

export async function getConfig(env: Env): Promise<ProxyConfig> {
  const now = Date.now();
  const cacheTTL = parseInt(env.CACHE_TTL || '43200000'); // 12 hours default

  // Check if cache is valid
  if (configCache && (now - configCache.cachedAt) < configCache.ttl) {
    return configCache.config;
  }

  // Fetch from KV
  try {
    const configJson = await env.PROXY_CONFIG.get('config');
    
    if (!configJson) {
      // No config found, return empty config
      const emptyConfig: ProxyConfig = { routes: [], version: '1.0' };
      configCache = {
        config: emptyConfig,
        cachedAt: now,
        ttl: cacheTTL
      };
      return emptyConfig;
    }

    const config: ProxyConfig = JSON.parse(configJson);
    
    // Validate config structure
    if (!config.routes || !Array.isArray(config.routes)) {
      throw new Error('Invalid config: routes must be an array');
    }

    // Default to enforcing origin checks unless explicitly disabled
    config.originChecksEnabled = config.originChecksEnabled ?? true;

    // Cache the config
    configCache = {
      config,
      cachedAt: now,
      ttl: cacheTTL
    };

    return config;
  } catch (error) {
    console.error('Error loading config from KV:', error);
    
    // Return cached config if available, otherwise empty config
    if (configCache) {
      return configCache.config;
    }
    
    return { routes: [], version: '1.0' };
  }
}

export function flushCache(): void {
  configCache = null;
}
