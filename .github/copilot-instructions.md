# Copilot Instructions for Proxy Load Balancer

## Project Overview

Cloudflare Worker-based proxy load balancer built with Hono. Routes requests to backend services using configurable path prefix matching with rate limiting, origin validation, and Turnstile verification.

**Live:** https://proxy-load-balancer.mdaburaihansrabon.workers.dev

## Build, Test, and Deploy Commands

```bash
# Local development
pnpm run dev          # Start local dev server at http://localhost:8787

# Deploy
pnpm run deploy       # Deploy to Cloudflare Workers

# View logs
pnpm run tail         # Stream live logs from production worker

# Test locally
./test-local.sh       # Run all local integration tests (requires local dev server running)
```

### KV Management

```bash
# Upload config to KV
pnpm exec wrangler kv key put --namespace-id=2c61e09e1d7842b5a8b00e61a2c2e6be "config" --path=config.json --remote

# Get current config
pnpm exec wrangler kv key get --namespace-id=2c61e09e1d7842b5a8b00e61a2c2e6be "config" --remote | jq .

# Flush worker config cache after KV update
curl -X POST https://proxy-load-balancer.mdaburaihansrabon.workers.dev/admin/cache-flush
```

## Architecture

### Request Flow (First-Match-Wins)

1. **Security checks** (in order):
   - Blocklist check (`blockedOrigins` config)
   - Turnstile verification (if `turnstileSecretKey` set)
   - Preliminary rate limiting (anonymous users)
   - Route matching (404 if no match)
   - Refined rate limiting (with route context)
   - Origin validation (if `allowedOrigins` config)

2. **URL rewriting**:
   - Match first route by prefix (top-to-bottom order)
   - Strip matched prefix from path
   - Append remaining path to target URL
   - Preserve all query parameters

3. **Proxying**:
   - Stream request/response (no buffering)
   - 120s timeout (configurable via `REQUEST_TIMEOUT`)
   - Add X-Forwarded-For, X-Forwarded-Proto headers
   - Override Host header to backend host
   - Remove Origin/Referer headers

4. **Logging**: All requests logged as structured JSON with timing, status, errors

### Key Components

- **`src/router.ts`**: Request proxying, route matching, URL rewriting, security orchestration
- **`src/config.ts`**: KV-based config with 12-hour in-memory cache, schema definitions
- **`src/ratelimit.ts`**: Per-IP fixed-window rate limiting (in-memory, per-isolate)
- **`src/turnstile.ts`**: Cloudflare Turnstile bot protection
- **`src/logger.ts`**: Structured JSON logging with audit types
- **`src/index.ts`**: Hono app, admin endpoints (/health, /admin/cache-flush)

### Configuration Storage

Configuration lives in **Cloudflare KV** (`PROXY_CONFIG` namespace, key: `config`) and is cached in-memory for 12 hours. See `config.example.json` for schema.

## Code Conventions

### Route Matching

- **First-match-wins**: Routes evaluated top-to-bottom in config order
- More specific prefixes MUST come before generic ones:
  ```json
  {
    "routes": [
      { "prefix": "/api/v2/users", "target": "..." },  // ✅ Specific first
      { "prefix": "/api/v2", "target": "..." },
      { "prefix": "/api", "target": "..." },
      { "prefix": "/", "target": "..." }               // ✅ Catch-all last
    ]
  }
  ```
- Prefix matching supports exact match (`/api/v1`) and path segments (`/api/v1/users` matches prefix `/api/v1`)

### URL Rewriting Pattern

```typescript
// Implemented in router.ts:joinPaths() and findMatchingRoute()
// Request: /api/v1/users/123?page=1
// Matched prefix: /api/v1
// Target: https://backend.example.com
// Result: https://backend.example.com/users/123?page=1
```

Path suffix is appended to target URL's pathname, query params always preserved.

### Security Response Patterns

**Rate limiting**:
- All users: 403 with empty body or 429 with JSON details + Retry-After header

**Origin blocking**: 403 with error message

All security events logged with `auditType` field for monitoring.

### Error Handling

- **503 Service Unavailable**: Backend unreachable or network error (includes stack trace)
- **504 Gateway Timeout**: Backend didn't respond within timeout (includes timeout duration)
- **404 Not Found**: No matching route
- **4xx/5xx from backend**: Pass through as-is

### Logging Pattern

All requests logged via `createLogEntry()` with:
- ISO 8601 timestamp
- Method, path, status, responseTime
- Matched prefix, target URL
- Security events: `auditType` field (RATE_LIMIT_EXCEEDED, BLOCKLIST_HIT, etc.)
- Error details and stack traces for failures

Use `url` parameter (pre-parsed URL) when available to avoid re-parsing.

### Authentication

> **Authentication support coming soon.**

### Rate Limiting

In-memory fixed-window algorithm (per-isolate, resets on cold start):

**Configuration options**:
- `rateLimit.requestsPerWindow`: Baseline limit per IP
- `rateLimit.windowSeconds`: Time window (fixed window algorithm)
- `route.rateLimitMultiplier`: Per-route adjustment (0.5 = half, 2.0 = double)

Stored per client IP in `Map<string, { count, windowStart }>`.

### CORS Headers

- If `allowedOrigins` configured and request has Origin header: Set `Access-Control-Allow-Origin` to origin + `Vary: Origin`
- Otherwise: `Access-Control-Allow-Origin: *`
- Always set: Allow-Methods, Allow-Headers, Expose-Headers
- Always delete: Access-Control-Allow-Credentials (not supported with wildcard)

### Config Schema Normalization

When loading config from KV:
- Set `config.originChecksEnabled` default to `true` if missing
- Validate routes is an array

### Admin Endpoints

- `GET /health`: Returns `{ status: "ok", timestamp }` - no auth required
- `POST /admin/cache-flush`: Clears in-memory config cache - requires `X-Admin-Key` header if `ADMIN_KEY` env var set

## Environment Variables

Set in `wrangler.toml` under `[vars]`:

- `REQUEST_TIMEOUT`: Request timeout in ms (default: 120000)
- `CACHE_TTL`: Config cache TTL in ms (default: 43200000 = 12h)
- `ADMIN_KEY`: Optional key for /admin/cache-flush endpoint
- `LOG_LEVEL`: Log filtering (DEBUG | INFO | WARN | ERROR | NONE)

## Common Pitfalls

1. **Using IP addresses in target URLs**: Cloudflare requires domain names with proper Host headers. Always use domain names:
   ```json
   ❌ "target": "http://161.118.204.135"
   ✅ "target": "https://demo.lazycoder.ninja"
   ```

2. **Route order matters**: Generic routes MUST come after specific ones. Wrong order causes specific routes to never match.

3. **Config cache**: After updating KV, either flush cache (`/admin/cache-flush`) or wait 12 hours. Or redeploy worker to force cache clear.

4. **In-memory rate limiting**: Limits are per-isolate and reset on cold starts. Not globally consistent across all edge locations.

## Additional Documentation

- **docs/architecture/ARCHITECTURE.md**: Detailed flow diagrams and component breakdown
- **SECURITY_DIAGRAM.md**: Security layer visualization
- **RATE_LIMITING_IMPLEMENTATION.md**: Rate limiting implementation details
- **DEPLOYMENT.md**: Production deployment notes
