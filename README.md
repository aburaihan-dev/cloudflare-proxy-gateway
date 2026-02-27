# Cloudflare Proxy Gateway

A production-ready edge proxy built on **Cloudflare Workers** and **Hono**. Route, cache, protect, and observe traffic to your backend services — all at the edge, globally.

**Live:** https://proxy-load-balancer.mdaburaihansrabon.workers.dev

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Admin Endpoints](#admin-endpoints)
- [Environment Variables](#environment-variables)
- [Response Codes](#response-codes)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Features

| Category | Feature | Description |
|---|---|---|
| **Routing** | Path prefix matching | First-match-wins routing, top-to-bottom order |
| **Routing** | URL rewriting | Strips matched prefix, appends rest to target |
| **Routing** | Query param passthrough | All query parameters preserved automatically |
| **Performance** | Response caching | KV-backed cache with stale-while-revalidate (80–95% latency reduction) |
| **Performance** | Request deduplication | Coalesces identical concurrent requests (10–20% backend savings) |
| **Performance** | Weighted load balancing | Distribute traffic across multiple backends by weight |
| **Reliability** | Circuit breaker | Three-state (CLOSED / OPEN / HALF_OPEN) pattern, prevents cascading failures |
| **Reliability** | Configurable timeouts | Default 120 s, returns 504 on timeout |
| **Security** | Rate limiting | Token bucket per IP with per-route multipliers |
| **Security** | API key management | Tier-based authentication and rate limits |
| **Security** | IP access control | CIDR-based allowlist / blocklist |
| **Security** | Origin validation | Block or restrict by Origin header |
| **Security** | Turnstile bot protection | Cloudflare Turnstile verification |
| **Security** | Request size limits | Configurable body / URL / header size caps |
| **Observability** | Structured JSON logging | Every request logged with method, path, status, timing |
| **Observability** | Real-time metrics | Request counts, latency percentiles (p50/p95/p99), error rates |
| **Observability** | Time-bucketed analytics | 1 m / 5 m / 1 h aggregations |
| **Advanced** | Geo-routing | Country / continent-based backend selection |
| **Advanced** | WebSocket detection | Identifies and flags WebSocket upgrade requests |
| **Config** | Zero-downtime updates | KV-backed config with 12 h in-memory cache + manual flush |

---

## Architecture

```
Client Request
    ↓
[Cloudflare Edge]
    ↓
[Proxy Worker] ← KV Config (cached 12h)
    ↓
[Security]      → Blocklist · Turnstile · Rate Limit · IP Control · Origin Validation
    ↓
[Cache Lookup]  → Serve from KV cache on hit
    ↓ (miss)
[Deduplication] → Coalesce identical in-flight requests
    ↓
[Circuit Breaker] → Skip unhealthy backends
    ↓
[Route Matcher] → First-match-wins prefix routing
    ↓
[Load Balancer] → Select backend (weighted)
    ↓
[Backend]       → Stream request / response (no buffering)
    ↓
[Cache Store]   → Write cacheable responses to KV
    ↓
[Client Response] + JSON log emitted
```

---

## Tech Stack

| | |
|---|---|
| **Runtime** | Cloudflare Workers (V8 isolates) |
| **Framework** | [Hono](https://hono.dev) 4.11.7 |
| **Language** | TypeScript 5.9.3 |
| **Storage** | Cloudflare KV (`PROXY_CONFIG`, `PROXY_CACHE`) |
| **Deployment** | Wrangler 4.61.1 |
| **Package manager** | pnpm |

---

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create KV namespaces

```bash
pnpm exec wrangler kv namespace create "PROXY_CONFIG"
pnpm exec wrangler kv namespace create "PROXY_CACHE"
```

Copy the generated IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PROXY_CONFIG"
id = "<your-config-namespace-id>"

[[kv_namespaces]]
binding = "PROXY_CACHE"
id = "<your-cache-namespace-id>"
```

### 3. Create your config

Copy the example and edit routes:

```bash
cp config.example.json config.json
```

Minimal working config:

```json
{
  "routes": [
    { "prefix": "/api", "target": "https://api.example.com" }
  ],
  "version": "2.0"
}
```

> **Rules:**
> - Always use domain names, not IP addresses
> - Use `https://`
> - More specific prefixes must come before generic ones

### 4. Upload config to KV

```bash
pnpm exec wrangler kv key put \
  --namespace-id=<your-config-namespace-id> \
  "config" \
  --path=config.json \
  --remote
```

### 5. Set admin key (optional but recommended)

```bash
pnpm exec wrangler secret put ADMIN_KEY
# Paste a strong key when prompted, e.g.: openssl rand -base64 32
```

### 6. Deploy

```bash
pnpm run deploy
```

### 7. Verify

```bash
curl https://<your-worker>.workers.dev/health
```

---

## Configuration

Full schema: [`config.example.json`](config.example.json)

### Route options

```jsonc
{
  "routes": [
    {
      "prefix": "/api/data",            // Required — path prefix to match
      "target": "https://backend.com",  // Required — backend URL
      "rateLimitMultiplier": 1.0,       // Optional — multiply global rate limit (default 1.0)
      "cache": "default",               // Optional — reference a cache profile by name
      "circuitBreaker": "default",      // Optional — reference a circuit breaker profile
      "deduplication": "default",       // Optional — reference a deduplication profile
      "sizeLimits": "strict"            // Optional — reference a size limits profile
    }
  ]
}
```

### Feature profiles

All features are **disabled by default** and opt-in via profile references on each route.

<details>
<summary><strong>Caching</strong></summary>

```json
"features": {
  "cache": {
    "enabled": true,
    "profiles": {
      "default": {
        "ttl": 300,
        "staleWhileRevalidate": 60,
        "varyBy": ["Accept-Language"],
        "bypassHeader": "X-No-Cache",
        "respectCacheControl": true
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Circuit Breaker</strong></summary>

```json
"features": {
  "circuitBreaker": {
    "enabled": true,
    "profiles": {
      "default": {
        "failureThreshold": 5,
        "timeout": 60000,
        "halfOpenAttempts": 3,
        "successThreshold": 2
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Rate Limiting</strong></summary>

```json
"rateLimit": {
  "enabled": true,
  "requestsPerWindow": 300,
  "windowSeconds": 300
}
```

Use `rateLimitMultiplier` on a route to tighten (`0.5`) or relax (`5.0`) the limit for that prefix.

</details>

<details>
<summary><strong>Request Size Limits</strong></summary>

```json
"features": {
  "sizeLimits": {
    "enabled": true,
    "default": {
      "maxBodySize": 10485760,
      "maxUrlLength": 8192,
      "maxHeaderSize": 16384,
      "maxHeaderCount": 100
    },
    "profiles": {
      "strict": { "maxBodySize": 5242880, "maxUrlLength": 4096 }
    }
  }
}
```

</details>

<details>
<summary><strong>Origin & IP Control</strong></summary>

```json
{
  "allowedOrigins": ["https://app.example.com", "http://localhost:3000"],
  "blockedOrigins": ["spam.example.com"]
}
```

</details>

---

## Admin Endpoints

All endpoints (except `/health`) require `X-Admin-Key: <key>` header.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check — no auth required |
| `/admin/cache-flush` | POST | Flush in-memory config cache |
| `/admin/metrics` | GET | Request metrics (`?window=1m\|5m\|1h\|all`) |
| `/admin/metrics/reset` | POST | Reset all metrics |
| `/admin/cache-stats` | GET | Response cache hit/miss stats |
| `/admin/cache-invalidate` | POST | Invalidate response cache (`?pattern=/api/*`) |
| `/admin/dedup-stats` | GET | Request deduplication stats |
| `/admin/circuit-breaker-status` | GET | Circuit breaker state per backend |
| `/admin/circuit-breaker-reset` | POST | Force-close circuit breakers (`?backend=<url>`) |

### Example

```bash
# Health
curl https://<worker>.workers.dev/health

# Metrics (last 5 minutes)
curl "https://<worker>.workers.dev/admin/metrics?window=5m" \
  -H "X-Admin-Key: $ADMIN_KEY"

# Flush config cache after a KV update
curl -X POST https://<worker>.workers.dev/admin/cache-flush \
  -H "X-Admin-Key: $ADMIN_KEY"
```

---

## Environment Variables

Set in `wrangler.toml` under `[vars]` or as Wrangler secrets:

| Variable | Default | Description |
|---|---|---|
| `REQUEST_TIMEOUT` | `120000` | Backend request timeout in ms |
| `CACHE_TTL` | `43200000` | Config cache TTL in ms (12 h) |
| `ADMIN_KEY` | _(empty)_ | Key required for admin endpoints |
| `LOG_LEVEL` | `INFO` | `DEBUG` · `INFO` · `WARN` · `ERROR` · `NONE` |

---

## Response Codes

| Code | Meaning |
|---|---|
| 200 | Request proxied successfully |
| 403 | Blocked origin, auth failure, or rate limit (anonymous) |
| 404 | No route matched the request path |
| 413 | Request body exceeds `maxBodySize` |
| 414 | URL exceeds `maxUrlLength` |
| 429 | Rate limit exceeded (authenticated users) |
| 431 | Headers exceed size/count limits |
| 503 | Backend unreachable or circuit breaker open |
| 504 | Backend timed out (default 120 s) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403` on every request | IP address used as target | Use a domain name in `target` |
| Config changes not taking effect | 12 h cache still valid | `POST /admin/cache-flush` or redeploy |
| Cache hit rate is 0% | Feature not enabled | Set `features.cache.enabled: true` and add `"cache": "profileName"` to route |
| `503` Circuit breaker open | Backend unhealthy | Check backend, then `POST /admin/circuit-breaker-reset` |
| `413` on uploads | Default size limit too small | Add a `sizeLimits` profile with higher `maxBodySize` |

**View live logs:**

```bash
pnpm run tail
```

---

## Project Structure

```
src/
├── index.ts                  # Hono app entry point, admin endpoints
├── router.ts                 # Route matching, proxying, security orchestration
├── config.ts                 # KV config loader with in-memory cache
├── logger.ts                 # Structured JSON logging
├── metrics.ts                # Time-bucketed metrics
├── ratelimit.ts              # Fixed-window rate limiter (legacy)
├── ratelimit-tokenbucket.ts  # Token bucket rate limiter
├── cache.ts                  # KV response cache
├── circuitbreaker.ts         # Three-state circuit breaker
├── deduplication.ts          # In-flight request coalescing
├── loadbalancer.ts           # Weighted backend selection
├── apikeys.ts                # API key management
├── ipcontrol.ts              # IP allowlist / blocklist (CIDR)
├── validation.ts             # Request size validation
├── georouting.ts             # Country / continent routing
├── websocket.ts              # WebSocket detection
├── turnstile.ts              # Cloudflare Turnstile verification
└── types/                    # Shared TypeScript types
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
