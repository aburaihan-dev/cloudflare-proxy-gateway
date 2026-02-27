import type { Env } from '../config';

/**
 * Core interface every auth adapter must implement.
 * Register adapters via src/auth/adapters/index.ts.
 */
export interface AuthAdapter {
  /** Unique adapter name — used as the "adapter" field in profile config */
  readonly name: string;

  /**
   * Returns the cache key for this request, or null to skip caching.
   * Called by the orchestrator before and after verify().
   * Typically: a hash of the token or the relevant request headers.
   */
  cacheKey(request: Request, config: Record<string, unknown>): string | null;

  /**
   * Core verification logic.
   * @param request  The incoming request (read-only — do not consume the body)
   * @param config   The raw profile config object from features.auth.profiles[name]
   * @param env      Worker environment bindings
   * @param ctx      Worker execution context (use ctx.waitUntil for background work)
   */
  verify(
    request: Request,
    config: Record<string, unknown>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<AuthResult>;
}

/**
 * Result returned by AuthAdapter.verify().
 */
export interface AuthResult {
  success: boolean;
  /** Headers injected into the upstream (backend) request on success */
  upstreamHeaders?: Record<string, string>;
  /**
   * Response returned directly to the client on failure (adapter has full control).
   * If omitted on failure, the orchestrator returns a plain 401 Unauthorized.
   */
  response?: Response;
}

export interface AuthProfileConfig {
  /** Registered adapter name to invoke */
  adapter: string;
  /** All other fields are adapter-specific and passed through as-is */
  [key: string]: unknown;
}

export interface AuthCacheConfig {
  enabled: boolean;
  /** KV binding name: "PROXY_AUTH_CACHE" (default, dedicated) or "PROXY_CACHE" (shared) */
  kvBinding?: string;
  /** Cache TTL in seconds */
  ttl: number;
}

export interface AuthFeatureConfig {
  enabled?: boolean;
  cache?: AuthCacheConfig;
  profiles: Record<string, AuthProfileConfig>;
}
