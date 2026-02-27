# Cloudflare Proxy Gateway

> A production-ready edge proxy built on Cloudflare Workers and Hono. Route, cache, protect, and observe traffic to your backend services — all at the edge, globally.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4.11-red)](https://hono.dev/)
[![Deploy Status](https://img.shields.io/badge/status-production-brightgreen)](https://proxy-load-balancer.mdaburaihansrabon.workers.dev/health)

**Live demo:** https://proxy-load-balancer.mdaburaihansrabon.workers.dev

---

## Table of Contents

- [Why This Project?](#why-this-project)
  - [vs. Cloudflare Transform Rules](#vs-cloudflare-transform-rules--router)
  - [vs. Kong Gateway](#vs-kong-gateway)
  - [When to use this project](#when-to-use-this-project)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Route options](#route-options)
  - [Caching](#caching)
  - [Circuit Breaker](#circuit-breaker)
  - [Rate Limiting](#rate-limiting)
  - [Request Size Limits](#request-size-limits)
  - [Origin & IP Control](#origin--ip-control)
- [Auth Adapters](#auth-adapters)
  - [Built-in adapters](#built-in-adapters)
  - [Writing a custom adapter](#writing-a-custom-adapter)
  - [Supabase example](#example-supabase-auth)
  - [Auth config reference](#auth-config-reference)
- [Admin Endpoints](#admin-endpoints)
- [Environment Variables](#environment-variables)
- [Response Codes](#response-codes)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Why This Project?

If you've ever tried to solve API routing, auth, and rate limiting on Cloudflare, you've likely looked at **Cloudflare routing rules** or **Kong Gateway**. Here's why this project exists and when it's the better choice.

### vs. Cloudflare Transform Rules / Router

Cloudflare's built-in routing tools (Transform Rules, URL Rewrites, Workers Routes) are great for simple cases — redirect `/old` to `/new`, add a header, block a country. But they hit a wall fast:

| | Cloudflare Rules | This Project |
|---|---|---|
| **Routing logic** | Point-and-click UI, 1 rule at a time | Code-based, unlimited routes in JSON config |
| **Custom auth** | Not possible | Full adapter pattern — any provider |
| **Circuit breaker** | ❌ Not available | ✅ Three-state, per-backend |
| **Response caching** | Basic (Cache Rules) | KV-backed, stale-while-revalidate, per-route TTLs |
| **Rate limiting** | Paid add-on ($5+/month per rule) | Built-in, per-IP, per-route multipliers |
| **Request deduplication** | ❌ Not available | ✅ In-memory coalescing |
| **Observability** | Cloudflare dashboard only | Structured JSON logs + `/admin/metrics` API |
| **Config updates** | Via dashboard or API, no versioning | JSON file in KV, version-controlled, zero-downtime flush |
| **Code ownership** | Cloudflare-managed, opaque | You own every line — fork, extend, audit |

> **Bottom line:** Cloudflare rules are designed for infrastructure teams making one-off UI changes. This project is for software teams who want routing logic that lives in code, is version-controlled, and is extended by writing TypeScript.

### vs. Kong Gateway

Kong is a powerful, battle-tested API gateway — and a significant operational commitment.

| | Kong Gateway | This Project |
|---|---|---|
| **Infrastructure** | Requires server/VM/container or ~$250+/month managed | Runs on Cloudflare Workers — no servers, no containers |
| **Global distribution** | Deploy to multiple regions manually | Runs in 300+ Cloudflare edge locations automatically |
| **Cold start** | Always-on (always paying) | <1 ms V8 isolate — zero idle cost |
| **Cost (low traffic)** | Server cost or $250+/month managed | ~$0 (Workers free tier: 100k req/day) |
| **Cost (high traffic)** | Scales with server size / plan | $0.50 per million requests |
| **Plugin system** | Lua / Go plugins, Kong plugin hub | TypeScript adapters — same language as your app |
| **Auth integration** | Kong plugins (JWT, OAuth2, Key Auth) | Pluggable adapter — any service, any logic |
| **Config management** | Admin API, deck CLI, or Konnect UI | Plain JSON in KV, version-controlled |
| **Learning curve** | High — Services, Routes, Plugins, Upstreams concepts | Low — JSON config + TypeScript for extensions |
| **Observability** | Requires Prometheus + Grafana or paid plan | Built-in JSON logs + metrics API out of the box |

> **Bottom line:** Kong is excellent if you already run Kubernetes with a platform team. If you're a product-focused team building on Cloudflare, this project gives you 80% of Kong's value with none of the operational overhead — and your routing logic is TypeScript, not a Lua plugin.

### When to use this project

✅ **Good fit if you:**
- Are already on Cloudflare Workers or want to move API traffic to the edge
- Want gateway logic in the same language and repo as your application
- Need custom auth that doesn't fit a checkbox in a UI
- Want zero-infrastructure, zero-idle-cost global routing
- Want config to be version-controlled and reviewed like application code

❌ **Not the right fit if you:**
- Need full WebSocket proxying (Workers supports limited pass-through only)
- Require gRPC traffic management
- Have strict data residency requirements conflicting with Cloudflare's edge
- Already run Kong and your team is invested in its plugin ecosystem

---

## Features

| Category | Feature | Description |
|---|---|---|
| **Routing** | Path prefix matching | First-match-wins routing, top-to-bottom order |
| **Routing** | URL rewriting | Strips matched prefix, appends rest to target |
| **Routing** | Query param passthrough | All query parameters preserved automatically |
| **Performance** | Response caching | KV-backed with stale-while-revalidate (80–95% latency reduction) |
| **Performance** | Request deduplication | Coalesces identical concurrent requests (10–20% backend savings) |
| **Performance** | Weighted load balancing | Distribute traffic across multiple backends by weight |
| **Reliability** | Circuit breaker | Three-state (CLOSED / OPEN / HALF_OPEN), prevents cascading failures |
| **Reliability** | Configurable timeouts | Default 120 s, returns 504 on timeout |
| **Security** | Rate limiting | Token bucket per IP with per-route multipliers |
| **Security** | API key management | Tier-based authentication and rate limits |
| **Security** | IP access control | CIDR-based allowlist / blocklist |
| **Security** | Origin validation | Block or restrict by `Origin` header |
| **Security** | Turnstile bot protection | Cloudflare Turnstile verification |
| **Security** | Request size limits | Configurable body / URL / header size caps |
| **Auth** | Auth Adapter system | Pluggable adapter interface — integrate any auth service without changing core code |
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
      │
      ▼
[Cloudflare Edge] ◄── KV Config (cached 12 h)
      │
      ├─► [Security]        Blocklist · Turnstile · Rate Limit · IP Control · Origin Check
      │
      ├─► [Auth]            Adapter lookup → cache check → verify() → inject upstream headers
      │
      ├─► [Cache Lookup]    Serve from KV cache on hit
      │         │ miss
      ├─► [Deduplication]   Coalesce identical in-flight requests
      │
      ├─► [Circuit Breaker] Skip unhealthy backends
      │
      ├─► [Route Matcher]   First-match-wins prefix routing
      │
      ├─► [Load Balancer]   Select backend (weighted)
      │
      ├─► [Backend]         Stream request / response (no buffering)
      │
      ├─► [Cache Store]     Write cacheable responses to KV
      │
      └─► [Client]          Response returned + JSON log emitted
```

---

## Tech Stack

| | |
|---|---|
| **Runtime** | Cloudflare Workers (V8 isolates, <1 ms cold start) |
| **Framework** | [Hono](https://hono.dev) 4.11.7 |
| **Language** | TypeScript 5.9.3 |
| **Storage** | Cloudflare KV (`PROXY_CONFIG`, `PROXY_CACHE`, `PROXY_AUTH_CACHE`) |
| **Deployment** | Wrangler 4.61.1 |
| **Package manager** | pnpm |

---

## Prerequisites

Before you start, make sure you have:

- **Node.js** 18+ installed
- **pnpm** installed (`npm install -g pnpm`)
- A **Cloudflare account** (free tier works)
- **Wrangler CLI** authenticated (`pnpm exec wrangler login`)

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd cloudflare-proxy-gateway
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

> **Important routing rules:**
> - Always use domain names, not IP addresses
> - Always use `https://`
> - More specific prefixes must come before generic ones (first-match-wins)

### 4. Upload config to KV

```bash
pnpm exec wrangler kv key put \
  --namespace-id=<your-config-namespace-id> \
  "config" \
  --path=config.json \
  --remote
```

### 5. Set admin key

```bash
pnpm exec wrangler secret put ADMIN_KEY
# Enter a strong random key, e.g.: openssl rand -base64 32
```

### 6. Deploy

```bash
pnpm run deploy
```

### 7. Verify

```bash
curl https://<your-worker>.workers.dev/health
# {"status":"ok","timestamp":"..."}
```

---

## Configuration

Full schema: [`config.example.json`](config.example.json)

All features are **disabled by default** and opt-in. Enable them globally in `features`, then reference profile names in routes.

### Route options

```jsonc
{
  "routes": [
    {
      "prefix": "/api/data",           // Required — path prefix to match
      "target": "https://backend.com", // Required — backend base URL
      "rateLimitMultiplier": 1.0,      // Optional — scale global rate limit for this route
      "cache": "default",              // Optional — cache profile name
      "circuitBreaker": "default",     // Optional — circuit breaker profile name
      "deduplication": "default",      // Optional — deduplication profile name
      "sizeLimits": "strict",          // Optional — size limits profile name
      "auth": "require-jwt"            // Optional — auth profile name
    }
  ]
}
```

### Caching

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

### Circuit Breaker

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

### Rate Limiting

```json
"rateLimit": {
  "enabled": true,
  "requestsPerWindow": 300,
  "windowSeconds": 300
}
```

Use `rateLimitMultiplier` on individual routes to tighten (`0.5`) or relax (`5.0`) the global limit.

### Request Size Limits

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

### Origin & IP Control

```json
{
  "allowedOrigins": ["https://app.example.com", "http://localhost:3000"],
  "blockedOrigins": ["spam.example.com"]
}
```

---

## Auth Adapters

The proxy ships an **adapter interface + registry** — you write the auth logic, the proxy calls it. No core code changes are ever needed.

> 📖 **Full step-by-step guide:** [docs/guides/AUTH_ADAPTER_GUIDE.md](docs/guides/AUTH_ADAPTER_GUIDE.md)

### Built-in adapters

| Adapter | Description |
|---|---|
| `jwt` | Validates Bearer tokens using JWKS (RS256/ES256) or shared secret (HS256). Configurable token extraction: `header`, `cookie`, `query`, `custom-header`. |
| `forward-auth` | Makes a subrequest to your auth service. `2xx` = pass; any other status is forwarded to the client as-is. |

### Writing a custom adapter

**1. Create** `src/auth/adapters/my-adapter.ts`:

```typescript
import type { AuthAdapter, AuthResult } from '../../types/auth';

export const myAdapter: AuthAdapter = {
  name: 'my-adapter',

  cacheKey(request, _config) {
    return request.headers.get('Authorization'); // null = never cache
  },

  async verify(request, config, env, ctx): Promise<AuthResult> {
    const token = request.headers.get('Authorization')?.slice(7);
    if (!token) {
      return {
        success: false,
        response: new Response(JSON.stringify({ error: 'Missing token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }
    // Your verification logic here...
    return {
      success: true,
      upstreamHeaders: { 'X-User-Id': 'user-123' },
    };
  },
};
```

**2. Register** in `src/auth/adapters/index.ts`:

```typescript
import { myAdapter } from './my-adapter';
registerAdapter(myAdapter);
```

**3. Reference** in `config.json`:

```json
{
  "prefix": "/api/private",
  "target": "https://backend.com",
  "auth": "my-profile"
}
```

### Example: Supabase Auth

A complete example lives at `src/auth/adapters/supabase.ts`. It validates Supabase access tokens locally (HS256), maps claims to upstream headers (`X-User-Id`, `X-User-Email`, `X-User-Role`), and supports an optional API verification fallback.

**Enable it** by uncommenting in `src/auth/adapters/index.ts`:

```typescript
import { supabaseAdapter } from './supabase';
registerAdapter(supabaseAdapter);
```

**Configure it:**

```json
{
  "routes": [{ "prefix": "/api/private", "target": "https://backend.com", "auth": "supabase" }],
  "features": {
    "auth": {
      "enabled": true,
      "cache": { "enabled": true, "ttl": 300 },
      "profiles": {
        "supabase": {
          "adapter": "supabase",
          "supabaseUrl": "https://xxxx.supabase.co",
          "supabaseJwtSecret": "your-jwt-secret"
        }
      }
    }
  }
}
```

### Auth config reference

```jsonc
"features": {
  "auth": {
    "enabled": true,
    "cache": {
      "enabled": true,
      "kvBinding": "PROXY_AUTH_CACHE",  // or "PROXY_CACHE" to reuse existing namespace
      "ttl": 300                         // seconds — successful decisions only
    },
    "profiles": {
      "my-profile": {
        "adapter": "jwt",               // registered adapter name
        "jwksUrl": "https://...",
        "audience": "my-api",
        "issuer": "https://..."
      }
    }
  }
}
```

**Optional: create a dedicated auth cache KV namespace:**

```bash
pnpm exec wrangler kv namespace create "PROXY_AUTH_CACHE"
# Paste the returned ID into the commented block in wrangler.toml
```

---

## Admin Endpoints

All endpoints except `/health` require the `X-Admin-Key` header.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Health check — no auth required |
| `/admin/cache-flush` | `POST` | Flush in-memory config cache |
| `/admin/metrics` | `GET` | Request metrics (`?window=1m\|5m\|1h\|all`) |
| `/admin/metrics/reset` | `POST` | Reset all metrics |
| `/admin/cache-stats` | `GET` | Response cache hit/miss stats |
| `/admin/cache-invalidate` | `POST` | Invalidate response cache (`?pattern=/api/*`) |
| `/admin/dedup-stats` | `GET` | Request deduplication stats |
| `/admin/circuit-breaker-status` | `GET` | Circuit breaker state per backend |
| `/admin/circuit-breaker-reset` | `POST` | Force-close circuit breakers (`?backend=<url>`) |

**Usage examples:**

```bash
# Health check
curl https://<worker>.workers.dev/health

# View metrics for the last 5 minutes
curl "https://<worker>.workers.dev/admin/metrics?window=5m" \
  -H "X-Admin-Key: $ADMIN_KEY"

# Flush config cache after a KV update
curl -X POST https://<worker>.workers.dev/admin/cache-flush \
  -H "X-Admin-Key: $ADMIN_KEY"
```

---

## Environment Variables

Set under `[vars]` in `wrangler.toml`, or as secrets via `wrangler secret put`:

| Variable | Default | Description |
|---|---|---|
| `REQUEST_TIMEOUT` | `120000` | Backend request timeout in milliseconds |
| `CACHE_TTL` | `43200000` | Config cache TTL in milliseconds (12 h) |
| `ADMIN_KEY` | _(empty)_ | Required key for all `/admin/*` endpoints |
| `LOG_LEVEL` | `INFO` | Log verbosity: `DEBUG` · `INFO` · `WARN` · `ERROR` · `NONE` |

---

## Response Codes

| Code | Meaning |
|---|---|
| `200` | Request proxied successfully |
| `401` | Authentication required or token invalid |
| `403` | Blocked origin, IP blocked, or rate limit exceeded (anonymous) |
| `404` | No route matched the request path |
| `413` | Request body exceeds `maxBodySize` |
| `414` | URL exceeds `maxUrlLength` |
| `429` | Rate limit exceeded |
| `431` | Headers exceed size or count limits |
| `503` | Backend unreachable or circuit breaker open |
| `504` | Backend timed out (default 120 s) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403` on every request | IP address used as `target` | Use a domain name, not an IP |
| Config changes not reflected | 12 h in-memory cache | `POST /admin/cache-flush` or redeploy |
| Cache hit rate is 0% | Feature not enabled | Set `features.cache.enabled: true` and add `"cache": "profileName"` to route |
| `503` Circuit breaker open | Backend returning 5xx errors | Check backend health, then `POST /admin/circuit-breaker-reset` |
| `413` on file uploads | Default size limit too small | Add a `sizeLimits` profile with a higher `maxBodySize` |
| `401` on every authenticated request | Adapter not registered | Check `src/auth/adapters/index.ts` and verify adapter `name` matches config |

**Stream live logs:**

```bash
pnpm run tail
```

**View aggregated metrics:**

```bash
curl "https://<worker>.workers.dev/admin/metrics?window=all" \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

---

## Project Structure

```
cloudflare-proxy-gateway/
├── src/
│   ├── index.ts                   # Hono app entry point, admin endpoints
│   ├── router.ts                  # Route matching, proxying, pipeline orchestration
│   ├── config.ts                  # KV config loader with in-memory cache
│   ├── logger.ts                  # Structured JSON logging
│   ├── metrics.ts                 # Time-bucketed metrics collection
│   ├── cache.ts                   # KV response cache
│   ├── circuitbreaker.ts          # Three-state circuit breaker
│   ├── deduplication.ts           # In-flight request coalescing
│   ├── loadbalancer.ts            # Weighted backend selection
│   ├── ratelimit.ts               # Fixed-window rate limiter
│   ├── ratelimit-tokenbucket.ts   # Token bucket rate limiter
│   ├── apikeys.ts                 # API key management
│   ├── ipcontrol.ts               # IP allowlist / blocklist (CIDR)
│   ├── validation.ts              # Request size validation
│   ├── georouting.ts              # Country / continent routing
│   ├── websocket.ts               # WebSocket detection
│   ├── turnstile.ts               # Cloudflare Turnstile verification
│   ├── auth/
│   │   ├── index.ts               # Auth orchestrator (cache → verify → store)
│   │   ├── registry.ts            # Adapter registration and lookup
│   │   ├── cache.ts               # KV auth decision cache
│   │   └── adapters/
│   │       ├── index.ts           # ← Register adapters here (only file you edit)
│   │       ├── jwt.ts             # Built-in: JWT adapter (JWKS + HS256)
│   │       ├── forward-auth.ts    # Built-in: forward-auth adapter
│   │       └── supabase.ts        # Example: Supabase custom adapter
│   └── types/
│       ├── auth.ts                # AuthAdapter interface, AuthResult
│       ├── cache.ts               # Cache types
│       ├── circuitbreaker.ts      # Circuit breaker types
│       ├── loadbalancer.ts        # Load balancer types
│       └── metrics.ts             # Metrics types
├── docs/
│   └── guides/
│       ├── AUTH_ADAPTER_GUIDE.md  # Auth integration guide for developers
│       ├── CONFIGURATION_GUIDE.md
│       └── DEPLOYMENT.md
├── config.example.json            # Annotated config schema
├── wrangler.toml                  # Cloudflare Workers configuration
└── tsconfig.json
```

---

## Contributing

Contributions are welcome. To add a new feature or fix a bug:

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and verify TypeScript compiles: `pnpm exec tsc --noEmit`
4. Test locally: `pnpm run dev`
5. Open a pull request with a clear description of the change

For new auth adapters, see [docs/guides/AUTH_ADAPTER_GUIDE.md](docs/guides/AUTH_ADAPTER_GUIDE.md) — the adapter pattern means you don't need to touch any core files.

---

## License

MIT — see [LICENSE](LICENSE) for details.
