import { Hono } from 'hono';
import { Env, flushCache, getConfig } from './config';
import { proxyRequest } from './router';
import { log, createLogEntry, setLogLevel, LogLevel } from './logger';
import { metrics } from './metrics';
import { CacheManager } from './cache';
import { deduplicator } from './deduplication';
import { circuitBreaker } from './circuitbreaker';

const app = new Hono<{ Bindings: Env }>();

// Initialize log level from environment on first request
let logLevelInitialized = false;

function initializeLogLevel(env: Env): void {
  if (logLevelInitialized) return;
  
  const logLevel = (env.LOG_LEVEL as LogLevel) || 'INFO';
  setLogLevel(logLevel);
  logLevelInitialized = true;
}

// Admin endpoint to flush cache
app.post('/admin/cache-flush', (c) => {
  initializeLogLevel(c.env);
  const startTime = Date.now();
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  if (adminKey && providedKey !== adminKey) {
    const responseTime = Date.now() - startTime;
    log(createLogEntry(c.req.raw, 401, responseTime, {
      error: 'Unauthorized cache flush attempt'
    }));
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  flushCache();
  
  const responseTime = Date.now() - startTime;
  log(createLogEntry(c.req.raw, 200, responseTime));
  
  return c.json({ 
    success: true, 
    message: 'Cache flushed successfully' 
  });
});

// Admin endpoint to get metrics
app.get('/admin/metrics', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const config = await getConfig(c.env);
  
  if (!config.features?.metrics?.enabled) {
    return c.json({ 
      success: false, 
      message: 'Metrics collection is not enabled' 
    }, 400);
  }
  
  const window = c.req.query('window') as '1m' | '5m' | '1h' | 'all' || 'all';
  const snapshot = metrics.getMetrics(window);
  
  return c.json({
    success: true,
    metrics: snapshot
  });
});

// Admin endpoint to reset metrics
app.post('/admin/metrics/reset', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  metrics.reset();
  
  return c.json({ 
    success: true, 
    message: 'Metrics reset successfully' 
  });
});

// Admin endpoint to get cache stats
app.get('/admin/cache-stats', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const metricsSnapshot = metrics.getMetrics('all');
  
  return c.json({
    success: true,
    cache: metricsSnapshot.cache
  });
});

// Admin endpoint to invalidate cache
app.post('/admin/cache-invalidate', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const prefix = c.req.query('prefix');
  
  if (!prefix) {
    return c.json({ 
      success: false, 
      message: 'Missing required query parameter: prefix' 
    }, 400);
  }
  
  const cacheManager = new CacheManager(c.env.PROXY_CACHE);
  const count = await cacheManager.invalidateByPrefix(prefix);
  
  return c.json({
    success: true,
    message: `Invalidated ${count} cache entries`,
    count
  });
});

// Admin endpoint to get deduplication stats
app.get('/admin/dedup-stats', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const stats = deduplicator.getStats();
  
  return c.json({
    success: true,
    deduplication: stats
  });
});

// Admin endpoint to get circuit breaker status
app.get('/admin/circuit-breaker-status', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const backend = c.req.query('backend');
  const stats = circuitBreaker.getStats(backend);
  
  return c.json({
    success: true,
    circuitBreakers: stats
  });
});

// Admin endpoint to reset circuit breaker
app.post('/admin/circuit-breaker-reset', async (c) => {
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  
  if (adminKey && providedKey !== adminKey) {
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }
  
  const backend = c.req.query('backend');
  
  if (!backend) {
    return c.json({ 
      success: false, 
      message: 'Missing required query parameter: backend' 
    }, 400);
  }
  
  circuitBreaker.reset(backend);
  
  return c.json({
    success: true,
    message: `Circuit breaker reset for ${backend}`
  });
});

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Handle OPTIONS requests for CORS preflight
app.options('*', async (c) => {
  const config = await getConfig(c.env);
  const origin = c.req.header('Origin');
  
  // Default to wildcard if no restrictions
  let allowOrigin = '*';
  
  // If restrictions exist, check them
  if (config.originChecksEnabled !== false && config.allowedOrigins && config.allowedOrigins.length > 0) {
    if (origin && config.allowedOrigins.includes(origin)) {
      allowOrigin = origin;
    } else {
      // If restricted and origin doesn't match (or is missing), 
      // strictly speaking we should probably 403, 
      // but for OPTIONS often it's safer to just return a non-matching origin or null
      // to prevent the browser from proceeding.
      // However, returning 204 with a mismatching origin effectively blocks it.
      allowOrigin = 'null'; 
    }
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': '*'
  };

  // If we are varying origin, add Vary header
  if (allowOrigin !== '*') {
    headers['Vary'] = 'Origin';
  }

  return c.text('', 204 as any, headers);
});

// Catch-all proxy handler
app.all('*', async (c) => {
  initializeLogLevel(c.env);
  return proxyRequest(c);
});

export default app;
