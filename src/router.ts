import { Context } from 'hono';
import { Env, Route, getConfig, ProxyConfig, DeduplicationConfig } from './config';
import { log, createLogEntry } from './logger';
import { verifyTurnstileToken } from './turnstile';
import { checkRateLimit } from './ratelimit';
import { metrics } from './metrics';
import { validateRequestSize, DEFAULT_LIMITS, SizeLimits } from './validation';
import { CacheManager, shouldBypassCache } from './cache';
import { deduplicator } from './deduplication';
import { circuitBreaker } from './circuitbreaker';
import { CacheConfig } from './types/cache';
import { CircuitBreakerConfig } from './types/circuitbreaker';
import { AuthFeatureConfig } from './types/auth';
import { runAuth } from './auth/index';

export interface MatchedRoute {
  route: Route;
  remainingPath: string;
}

// Feature profile resolvers — return config if feature is enabled and profile exists, null otherwise
function resolveCache(config: ProxyConfig, route: Route): CacheConfig | null {
  if (!config.features?.cache?.enabled || !route.cache) return null;
  return config.features.cache.profiles[route.cache] ?? null;
}

function resolveCircuitBreaker(config: ProxyConfig, route: Route): CircuitBreakerConfig | null {
  if (!config.features?.circuitBreaker?.enabled || !route.circuitBreaker) return null;
  return config.features.circuitBreaker.profiles[route.circuitBreaker] ?? null;
}

function resolveDeduplication(config: ProxyConfig, route: Route): DeduplicationConfig | null {
  if (!config.features?.deduplication?.enabled || !route.deduplication) return null;
  return config.features.deduplication.profiles[route.deduplication] ?? null;
}

function resolveSizeLimits(config: ProxyConfig, route: Route): SizeLimits | null {
  if (!config.features?.sizeLimits?.enabled) return null;
  if (route.sizeLimits) {
    return config.features.sizeLimits.profiles[route.sizeLimits] ?? null;
  }
  return config.features.sizeLimits.default ?? null;
}

function resolveAuth(config: ProxyConfig, route: Route): AuthFeatureConfig | null {
  if (!config.features?.auth?.enabled || !route.auth) return null;
  return config.features.auth.profiles[route.auth] ? config.features.auth : null;
}

function isMetricsEnabled(config: ProxyConfig): boolean {
  return config.features?.metrics?.enabled === true;
}

/**
 * Checks if the request is explicitly blocked.
 * Checks: Origin, Referer, and cf-worker header.
 */
function isCallerBlocked(request: Request, config: ProxyConfig): boolean {
  if (!config.blockedOrigins || config.blockedOrigins.length === 0) {
    return false;
  }

  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const cfWorker = request.headers.get('cf-worker');

  return config.blockedOrigins.some(blocked => {
    return (origin && origin.includes(blocked)) ||
           (referer && referer.includes(blocked)) ||
           (cfWorker && cfWorker.includes(blocked));
  });
}

/**
 * Checks if the request's Origin is allowed.
 * - If config.allowedOrigins is missing or empty, ALLOW all (default behavior).
 * - If Origin header is missing, ALLOW (assumes non-browser tool like curl/server).
 * - If Origin is present, it MUST match one of the entries in allowedOrigins.
 * - Supports wildcard patterns: "*.example.com" matches "app.example.com", "api.example.com", etc.
 */
function isOriginAllowed(origin: string | null, config: ProxyConfig): boolean {
  if (config.originChecksEnabled === false) {
    return true;
  }
  if (!config.allowedOrigins || config.allowedOrigins.length === 0) {
    return true;
  }
  // Allow non-browser requests (no Origin header)
  if (!origin) {
    return true;
  }
  
  // Extract hostname from origin URL (e.g., "https://app.example.com" -> "app.example.com")
  let originHostname: string;
  try {
    const originUrl = new URL(origin);
    originHostname = originUrl.hostname;
  } catch {
    // If origin is not a valid URL, use it as-is for comparison
    originHostname = origin;
  }
  
  return config.allowedOrigins.some(allowed => {
    // Exact match (supports full URLs or hostnames)
    if (allowed === origin || allowed === originHostname) {
      return true;
    }
    
    // Wildcard match: "*.example.com" matches "app.example.com"
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2); // Remove "*."
      return originHostname.endsWith('.' + domain) || originHostname === domain;
    }
    
    return false;
  });
}

function isPrefixMatch(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) {
    return path.startsWith(prefix);
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

function joinPaths(basePath: string, suffix: string): string {
  const base = basePath === '/' ? '' : basePath;
  if (!suffix) {
    return base || '/';
  }
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (!base) {
    return normalizedSuffix;
  }
  return base.endsWith('/')
    ? `${base.slice(0, -1)}${normalizedSuffix}`
    : `${base}${normalizedSuffix}`;
}

export function findMatchingRoute(path: string, routes: Route[]): MatchedRoute | null {
  // First-match-wins: iterate in order
  for (const route of routes) {
    if (isPrefixMatch(path, route.prefix)) {
      // Extract remaining path after prefix
      const remainingPath = path.slice(route.prefix.length);
      return { route, remainingPath };
    }
  }
  return null;
}

export async function proxyRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const startTime = Date.now();
  let request = c.req.raw;
  const url = new URL(request.url);
  
  try {
    // Get config
    const config = await getConfig(c.env);
    
    // Security Check: Blocklist (Explicit Deny)
    if (isCallerBlocked(request, config)) {
      const responseTime = Date.now() - startTime;
      const blockedReason = request.headers.get('cf-worker') ? 'Blocked Worker' : 'Blocked Origin';
      
      log(createLogEntry(request, 403, responseTime, { 
        error: 'Access blocked by policy',
        reason: blockedReason,
        origin: request.headers.get('Origin') || 'null',
        worker: request.headers.get('cf-worker') || 'null',
        auditType: 'BLOCKLIST_HIT',
        url
      }));
      return new Response('Forbidden: Access blocked by policy', { status: 403 });
    }

    // Security Check: Turnstile Verification
    if (config.turnstileSecretKey) {
      const token = request.headers.get('X-Turnstile-Token');
      const clientIp = request.headers.get('CF-Connecting-IP') || undefined;
      
      const isValid = await verifyTurnstileToken(token || '', config.turnstileSecretKey, clientIp);
      
      if (!isValid) {
        const responseTime = Date.now() - startTime;
        log(createLogEntry(request, 403, responseTime, { 
          error: 'Turnstile verification failed',
          hasToken: !!token,
          auditType: 'TURNSTILE_FAILED',
          url
        }));
        
        // Record metrics
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(403, responseTime, true);
        }
        
        return new Response(JSON.stringify({
          error: 'Forbidden',
          message: 'Turnstile verification failed. Please provide a valid X-Turnstile-Token header.'
        }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Security Check: Rate Limiting (preliminary check before route matching)
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    if (config.rateLimit?.enabled && clientIp !== 'unknown') {
      const prelimCheck = checkRateLimit(clientIp, config);
      
      if (!prelimCheck.allowed) {
        const responseTime = Date.now() - startTime;
        log(createLogEntry(request, 429, responseTime, {
          error: 'Rate limit exceeded',
          clientIp,
          limit: prelimCheck.limit,
          current: prelimCheck.current,
          retryAfter: prelimCheck.retryAfter,
          auditType: 'RATE_LIMIT_EXCEEDED',
          url
        }));
        
        // Record metrics
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(429, responseTime, true);
          metrics.recordRateLimit(true);
        }
        
        return new Response(JSON.stringify({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Please retry after ${prelimCheck.retryAfter} seconds.`,
          retryAfter: prelimCheck.retryAfter
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(prelimCheck.retryAfter)
          }
        });
      }
      
      // Record rate limit allowed
      if (isMetricsEnabled(config)) {
        metrics.recordRateLimit(false);
      }
    }

    // Find matching route
    const match = findMatchingRoute(url.pathname, config.routes);
    
    if (!match) {
      const responseTime = Date.now() - startTime;
      log(createLogEntry(request, 404, responseTime, { 
        error: 'No matching route found',
        url
      }));
      
      // Record metrics
      if (isMetricsEnabled(config)) {
        metrics.recordRequest(404, responseTime, true);
      }
      
      return new Response('No matching route found', { status: 404 });
    }
    
    const { route, remainingPath } = match;

    // Validation Check: Request Size Limits
    const sizeLimitsConfig = resolveSizeLimits(config, route);
    if (sizeLimitsConfig) {
      const validationResult = validateRequestSize(request, sizeLimitsConfig);
      
      if (!validationResult.valid) {
        const responseTime = Date.now() - startTime;
        const statusCode = validationResult.statusCode || 400;
        
        log(createLogEntry(request, statusCode, responseTime, {
          error: 'Request size validation failed',
          reason: validationResult.error,
          auditType: 'SIZE_LIMIT_EXCEEDED',
          url
        }));
        
        // Record metrics
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(statusCode, responseTime, true);
        }
        
        return new Response(validationResult.error, { status: statusCode });
      }
    }

    // Security Check: Rate Limiting (refined check with route context)
    if (config.rateLimit?.enabled && clientIp !== 'unknown') {
      const rateLimitCheck = checkRateLimit(clientIp, config, route);
      
      if (!rateLimitCheck.allowed) {
        const responseTime = Date.now() - startTime;
        
        log(createLogEntry(request, 429, responseTime, {
          error: 'Rate limit exceeded',
          clientIp,
          limit: rateLimitCheck.limit,
          current: rateLimitCheck.current,
          retryAfter: rateLimitCheck.retryAfter,
          routePrefix: route.prefix,
          auditType: 'RATE_LIMIT_EXCEEDED',
          url
        }));
        
        return new Response(JSON.stringify({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Please retry after ${rateLimitCheck.retryAfter} seconds.`,
          limit: rateLimitCheck.limit,
          retryAfter: rateLimitCheck.retryAfter
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rateLimitCheck.retryAfter)
          }
        });
      }
    }

    // Security Check: Validate Origin
    const origin = request.headers.get('Origin');
    if (!isOriginAllowed(origin, config)) {
      const responseTime = Date.now() - startTime;
      log(createLogEntry(request, 403, responseTime, { 
        error: 'Origin not allowed',
        origin: origin || 'null',
        auditType: 'ORIGIN_BLOCKED',
        url
      }));
      return new Response('Forbidden: Origin not allowed', { status: 403 });
    }

    // Security Check: Auth Adapter
    const authFeatureConfig = resolveAuth(config, route);
    if (authFeatureConfig && route.auth) {
      const profileConfig = authFeatureConfig.profiles[route.auth];
      const authResult = await runAuth(request, profileConfig, authFeatureConfig, c.env, c.executionCtx);

      if (!authResult.success) {
        const responseTime = Date.now() - startTime;
        log(createLogEntry(request, authResult.response?.status ?? 401, responseTime, {
          error: 'Auth failed',
          adapter: profileConfig.adapter,
          routePrefix: route.prefix,
          auditType: 'AUTH_FAILED',
          url,
        }));
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(authResult.response?.status ?? 401, responseTime, true);
        }
        return authResult.response ?? new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Inject upstream headers returned by the adapter
      if (authResult.upstreamHeaders) {
        const mutableHeaders = new Headers(request.headers);
        for (const [key, value] of Object.entries(authResult.upstreamHeaders)) {
          mutableHeaders.set(key, value);
        }
        // Reconstruct the request with the enriched headers
        request = new Request(request, { headers: mutableHeaders });
      }
    }

    // Initialize cache manager
    const cacheManager = new CacheManager(c.env.PROXY_CACHE);
    
    // Resolve feature profiles for this route
    const cacheConfig = resolveCache(config, route);
    const cbConfig = resolveCircuitBreaker(config, route);
    const dedupConfig = resolveDeduplication(config, route);
    
    // Check for cache hit (if caching is enabled for this route)
    if (cacheConfig && request.method === 'GET') {
      const bypassCache = shouldBypassCache(request, cacheConfig);
      
      if (!bypassCache) {
        const cacheKeyOptions = {
          method: request.method,
          url: request.url,
          varyBy: cacheConfig.varyBy,
          headers: request.headers
        };
        
        const cacheKey = cacheManager.generateCacheKey(cacheKeyOptions);
        const cachedEntry = await cacheManager.get(cacheKey);
        
        if (cachedEntry) {
          const responseTime = Date.now() - startTime;
          
          // Record cache hit
          if (isMetricsEnabled(config)) {
            metrics.recordCache(true);
            metrics.recordRequest(cachedEntry.response.status, responseTime, false);
          }
          
          log(createLogEntry(request, cachedEntry.response.status, responseTime, {
            matchedPrefix: route.prefix,
            cacheHit: true,
            cacheKey,
            url
          }));
          
          const stale = (cachedEntry as any).stale || false;
          return cacheManager.createResponseFromCache(cachedEntry, stale);
        }
        
        // Record cache miss
        if (isMetricsEnabled(config)) {
          metrics.recordCache(false);
        }
      }
    }
    
    // Request Deduplication (if enabled for this route)
    if (dedupConfig && request.method === 'GET') {
      const requestHash = deduplicator.generateRequestHash(request);
      
      if (deduplicator.hasPending(requestHash)) {
        // Wait for existing request to complete
        const pending = deduplicator.getPending(requestHash);
        
        if (pending) {
          const responseTime = Date.now() - startTime;
          
          log(createLogEntry(request, 200, responseTime, {
            matchedPrefix: route.prefix,
            deduplicated: true,
            requestHash,
            url
          }));
          
          // Clone the response for this request
          const response = await pending;
          return response.clone();
        }
      }
    }
    
    // Build target URL: target + remainingPath + query params
    const targetUrl = new URL(route.target);
    targetUrl.pathname = joinPaths(targetUrl.pathname, remainingPath);
    targetUrl.search = url.search; // Preserve query params
    
    // Log the full constructed target URL
    const fullTargetUrl = targetUrl.toString();
    
    // Circuit Breaker Check
    if (cbConfig) {
      const check = circuitBreaker.canRequest(route.target, cbConfig);
      
      if (!check.allowed) {
        const responseTime = Date.now() - startTime;
        
        log(createLogEntry(request, 503, responseTime, {
          error: 'Circuit breaker open',
          reason: check.reason,
          matchedPrefix: route.prefix,
          targetUrl: fullTargetUrl,
          auditType: 'CIRCUIT_BREAKER_OPEN',
          url
        }));
        
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(503, responseTime, true);
        }
        
        return new Response(JSON.stringify({
          error: 'Service Unavailable',
          message: 'Backend service is temporarily unavailable',
          reason: check.reason
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60'
          }
        });
      }
    }
    
    // Get timeout from environment
    const timeout = parseInt(c.env.REQUEST_TIMEOUT || '120000');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      // Forward all headers
      const headers = new Headers(request.headers);
      
      // Override Host header with target backend host
      headers.set('Host', targetUrl.host);
      
      // Remove Origin and Referer headers that might cause backend to reject
      headers.delete('Origin');
      headers.delete('Referer');
      
      // Add X-Forwarded headers
      const clientIp = request.headers.get('CF-Connecting-IP') || 
                       request.headers.get('X-Real-IP') || 
                       'unknown';
      const existingForwardedFor = headers.get('X-Forwarded-For');
      headers.set('X-Forwarded-For', existingForwardedFor
        ? `${existingForwardedFor}, ${clientIp}`
        : clientIp
      );
      headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
      
      // Make proxied request with streaming
      const proxyResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      const responseTime = Date.now() - startTime;
      log(createLogEntry(request, proxyResponse.status, responseTime, {
        matchedPrefix: route.prefix,
        targetUrl: fullTargetUrl,
        targetHost: targetUrl.host,
        url
      }));
      
      // Record metrics for successful proxy
      if (isMetricsEnabled(config)) {
        const isError = proxyResponse.status >= 400;
        metrics.recordRequest(proxyResponse.status, responseTime, isError);
      }
      
      // Record circuit breaker result
      if (cbConfig) {
        if (proxyResponse.status >= 500) {
          circuitBreaker.recordFailure(route.target, cbConfig);
        } else {
          circuitBreaker.recordSuccess(route.target, cbConfig);
        }
      }
      
      // Cache response if caching is enabled and response is cacheable
      if (cacheConfig && request.method === 'GET') {
        const cacheControl = proxyResponse.headers.get('Cache-Control');
        
        if (cacheManager.isCacheable(proxyResponse.status, cacheConfig, cacheControl)) {
          const cacheKeyOptions = {
            method: request.method,
            url: request.url,
            varyBy: cacheConfig.varyBy,
            headers: request.headers
          };
          
          const cacheKey = cacheManager.generateCacheKey(cacheKeyOptions);
          
          // Clone response for caching (we need to read the body)
          const responseClone = proxyResponse.clone();
          
          // Store in cache asynchronously (don't wait)
          cacheManager.set(cacheKey, responseClone, cacheConfig, route.prefix).catch(err => {
            console.error('Cache storage error:', err);
          });
        }
      }
      
      // Stream response back with CORS headers
      const responseHeaders = new Headers(proxyResponse.headers);
      
      // Handle CORS headers dynamically
      if (config.originChecksEnabled !== false && config.allowedOrigins && config.allowedOrigins.length > 0 && origin) {
        responseHeaders.set('Access-Control-Allow-Origin', origin);
        responseHeaders.append('Vary', 'Origin');
      } else {
        responseHeaders.set('Access-Control-Allow-Origin', '*');
      }

      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.set('Access-Control-Expose-Headers', '*');
      responseHeaders.delete('Access-Control-Allow-Credentials');
      
      return new Response(proxyResponse.body, {
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        headers: responseHeaders
      });
      
    } catch (error: any) {
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      
      if (error.name === 'AbortError') {
        log(createLogEntry(request, 504, responseTime, {
          matchedPrefix: route.prefix,
          targetUrl: fullTargetUrl,
          targetHost: targetUrl.host,
          timeout: true,
          error: 'Request timeout',
          url
        }));
        
        // Record metrics for timeout
        if (isMetricsEnabled(config)) {
          metrics.recordRequest(504, responseTime, true);
        }
        
        // Record circuit breaker failure
        if (cbConfig) {
          circuitBreaker.recordFailure(route.target, cbConfig);
        }
        
        return new Response(
          JSON.stringify({ 
            error: 'Gateway Timeout',
            message: `Backend did not respond within ${timeout}ms`,
            target: fullTargetUrl
          }),
          { 
            status: 504,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }
      
      log(createLogEntry(request, 503, responseTime, {
        matchedPrefix: route.prefix,
        targetUrl: fullTargetUrl,
        targetHost: targetUrl.host,
        error: error.message,
        url
      }));
      
      // Record metrics for service error
      if (isMetricsEnabled(config)) {
        metrics.recordRequest(503, responseTime, true);
      }
      
      // Record circuit breaker failure
      if (cbConfig) {
        circuitBreaker.recordFailure(route.target, cbConfig);
      }
      
      return new Response(
        JSON.stringify({
          error: 'Service Unavailable',
          message: error.message,
          target: fullTargetUrl,
          stack: error.stack
        }),
        { 
          status: 503,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }
    
  } catch (error: any) {
    const responseTime = Date.now() - startTime;
    log(createLogEntry(request, 500, responseTime, {
      error: error.message,
      url
    }));
    
    // Record metrics for internal error (use getConfig to access config)
    try {
      const config = await getConfig(c.env);
      if (isMetricsEnabled(config)) {
        metrics.recordRequest(500, responseTime, true);
      }
    } catch (e) {
      // Ignore config fetch errors in error handler
    }
    
    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
        stack: error.stack
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}
