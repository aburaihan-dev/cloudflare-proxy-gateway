# Configuration Guide — Proxy Load Balancer v2

> **Audience:** Anyone deploying this worker — developers, interns, or ops engineers.  
> **Goal:** Take you from zero to a fully configured, production-ready proxy with real working examples you can copy-paste.

---

## Table of Contents

1. [How Configuration Works](#how-configuration-works)
2. [Minimal Setup (5 minutes)](#minimal-setup)
3. [Understanding Routes](#understanding-routes)
4. [Understanding Features](#understanding-features)
5. [Feature: Response Caching](#feature-response-caching)
6. [Feature: Circuit Breaker](#feature-circuit-breaker)
7. [Feature: Request Deduplication](#feature-request-deduplication)
8. [Feature: Request Size Limits](#feature-request-size-limits)
9. [Feature: Metrics](#feature-metrics)
10. [Rate Limiting](#rate-limiting)
11. [Security: Origin Control](#security-origin-control)
13. [Combining Features](#combining-features)
14. [Real-World Examples](#real-world-examples)
15. [Uploading Your Config](#uploading-your-config)
16. [Troubleshooting](#troubleshooting)
17. [Complete Config Reference](#complete-config-reference)

---

## How Configuration Works

All configuration lives in a **single JSON file** stored in Cloudflare KV.

There are two main sections:

```
config.json
├── routes[]          ← WHERE to send requests (lightweight, references profile names)
├── features{}        ← HOW features behave (detailed settings, defined once, reused)
├── rateLimit{}       ← Global rate limiting settings
├── allowedOrigins[]  ← Which websites can call this proxy
├── blockedOrigins[]  ← Which websites are blocked
└── version           ← Config version string
```

### The Key Idea: Profiles

Instead of putting complex settings inside each route, you **define feature profiles once** and **reference them by name** in routes.

**Why?** Imagine you have 20 routes that all need the same cache settings. Instead of copying the same 7 lines into each route, you define one profile called `"default"` and just write `"cache": "default"` in each route.

### Two-Level Enable System

Every feature requires **two things** to be active:

1. **Feature must be globally enabled** — `features.cache.enabled: true`
2. **Route must reference a profile** — `"cache": "default"`

If either is missing, the feature is off for that route. This makes it safe — nothing is on by default.

---

## Minimal Setup

The absolute simplest config that works:

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://your-backend.example.com"
    }
  ],
  "version": "2.0"
}
```

**What this does:**
- Any request to `https://your-worker.workers.dev/api/anything` gets forwarded to `https://your-backend.example.com/anything`
- No caching, no rate limiting, no authentication — just a simple proxy
- All features are disabled by default

**Try it:**
```bash
# Save as config.json, then upload:
pnpm exec wrangler kv key put \
  --namespace-id=YOUR_KV_ID \
  "config" --path=config.json --remote

# Deploy:
pnpm run deploy

# Test:
curl https://your-worker.workers.dev/api/health
```

---

## Understanding Routes

Routes tell the proxy **where to send each request**. They are matched top-to-bottom — the first matching prefix wins.

### Route Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `prefix` | ✅ | string | URL path prefix to match (e.g., `/api/v2`) |
| `target` | ✅ | string | Backend URL to forward to |
| `rateLimitMultiplier` | ❌ | number | Multiply the global rate limit (default: `1.0`) |
| `cache` | ❌ | string | Name of cache profile to use |
| `circuitBreaker` | ❌ | string | Name of circuit breaker profile to use |
| `deduplication` | ❌ | string | Name of deduplication profile to use |
| `sizeLimits` | ❌ | string | Name of size limits profile to use |

### Route Matching Rules

```json
{
  "routes": [
    { "prefix": "/api/v2/admin", "target": "https://admin.example.com" },
    { "prefix": "/api/v2",       "target": "https://api-v2.example.com" },
    { "prefix": "/api",          "target": "https://api-v1.example.com" },
    { "prefix": "/",             "target": "https://website.example.com" }
  ]
}
```

**⚠️ Order matters!** Put specific prefixes BEFORE generic ones.

| Incoming Request | Matches | Forwards To |
|-----------------|---------|-------------|
| `/api/v2/admin/users` | `/api/v2/admin` | `https://admin.example.com/users` |
| `/api/v2/products` | `/api/v2` | `https://api-v2.example.com/products` |
| `/api/legacy` | `/api` | `https://api-v1.example.com/legacy` |
| `/about` | `/` | `https://website.example.com/about` |

### URL Rewriting

The matched prefix is stripped, and the remainder is appended to the target:

```
Request:  /api/v2/users/123?page=1
Prefix:   /api/v2
Target:   https://api-v2.example.com
Result:   https://api-v2.example.com/users/123?page=1
                                     └── remaining path + query preserved
```

### ⚠️ Important Rules

1. **Use domain names, NOT IP addresses** — Cloudflare requires hostnames
   ```
   ❌ "target": "http://161.118.204.135"
   ✅ "target": "https://api.example.com"
   ```

2. **Use HTTPS** — Always prefer `https://` for backend targets

3. **No trailing slashes on prefixes** — `/api` not `/api/`

---

## Understanding Features

Features are configured in the `features` section of your config. Each feature follows the same pattern:

```json
{
  "features": {
    "<featureName>": {
      "enabled": false,
      "profiles": {
        "<profileName>": { "...settings..." },
        "<anotherProfile>": { "...different settings..." }
      }
    }
  }
}
```

Then in routes, reference by profile name:

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://api.example.com",
      "<featureName>": "<profileName>"
    }
  ]
}
```

### All Features at a Glance

| Feature | What It Does | Default |
|---------|-------------|---------|
| `cache` | Stores backend responses to serve future requests faster | Disabled |
| `circuitBreaker` | Stops sending requests to failing backends | Disabled |
| `deduplication` | Combines identical requests happening at the same time | Disabled |
| `sizeLimits` | Rejects requests that are too large | Disabled |
| `metrics` | Collects request counts, latency, error statistics | Disabled |

---

## Feature: Response Caching

**What it does:** Saves backend responses so the same request doesn't hit the backend again. Instead, the proxy returns the saved response instantly.

**When to use:** Read-heavy APIs, static content, public data that doesn't change every second.

### Cache Profile Settings

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `ttl` | number | ✅ | How long to keep cached responses (in seconds) |
| `varyBy` | string[] | ❌ | Headers that make the cache unique per value (e.g., language) |
| `bypassHeader` | string | ❌ | Header name that skips cache (default: `X-No-Cache`) |
| `staleWhileRevalidate` | number | ❌ | Seconds to serve old cache while fetching fresh data |
| `respectCacheControl` | boolean | ❌ | Obey `Cache-Control` headers from backend (default: `true`) |
| `cacheableStatusCodes` | number[] | ❌ | Which HTTP codes to cache (default: `[200, 301, 404]` etc.) |

### Example 1: Basic Caching (5 minute TTL)

```json
{
  "routes": [
    {
      "prefix": "/api/products",
      "target": "https://api.example.com/products",
      "cache": "short"
    }
  ],
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "short": {
          "ttl": 300
        }
      }
    }
  },
  "version": "2.0"
}
```

**What happens:**
1. First request to `/api/products` → hits the backend, takes 300ms, response is saved
2. Next request within 5 minutes → served from cache in ~5ms
3. After 5 minutes → cache expires, next request hits backend again

### Example 2: Multiple Cache Profiles

```json
{
  "routes": [
    {
      "prefix": "/api/products",
      "target": "https://api.example.com/products",
      "cache": "short"
    },
    {
      "prefix": "/api/categories",
      "target": "https://api.example.com/categories",
      "cache": "medium"
    },
    {
      "prefix": "/static",
      "target": "https://cdn.example.com",
      "cache": "long"
    },
    {
      "prefix": "/api/user/profile",
      "target": "https://api.example.com/user/profile",
      "cache": "per-user"
    }
  ],
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "short": {
          "ttl": 300,
          "respectCacheControl": true
        },
        "medium": {
          "ttl": 1800,
          "staleWhileRevalidate": 300,
          "respectCacheControl": true
        },
        "long": {
          "ttl": 86400,
          "respectCacheControl": false
        },
        "per-user": {
          "ttl": 600,
          "varyBy": ["Authorization"],
          "respectCacheControl": true
        }
      }
    }
  },
  "version": "2.0"
}
```

**What each profile does:**

| Profile | TTL | Use Case |
|---------|-----|----------|
| `short` | 5 min | Product listings that update often |
| `medium` | 30 min | Categories that rarely change, serves stale for 5 min while refreshing |
| `long` | 24 hours | Static assets (CSS, JS, images), ignores backend cache headers |
| `per-user` | 10 min | User profiles — each user gets their own cached copy (keyed by `Authorization` header) |

### Example 3: Stale-While-Revalidate

```json
{
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "fast-stale": {
          "ttl": 60,
          "staleWhileRevalidate": 300
        }
      }
    }
  }
}
```

**Timeline:**
- 0–60s: Serves fresh cached response ✅
- 60–360s: Serves the old (stale) response immediately, fetches fresh data in the background
- After 360s: Cache is fully expired, next request waits for backend

### Bypassing Cache

Send the bypass header to force a fresh response:
```bash
curl https://your-worker.workers.dev/api/products \
  -H "X-No-Cache: true"
```

---

## Feature: Circuit Breaker

**What it does:** If a backend starts failing, the circuit breaker "opens" and stops sending requests to it. This prevents your proxy from wasting time on a dead backend and protects the backend from being hammered while it's recovering.

**When to use:** Any route where the backend might go down and you want fast failure instead of slow timeouts.

### Circuit Breaker Profile Settings

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `failureThreshold` | number | ✅ | Failures before circuit opens (e.g., `5`) |
| `timeout` | number | ✅ | Milliseconds to wait before trying again (e.g., `60000` = 1 min) |
| `halfOpenAttempts` | number | ✅ | Test requests to send when checking recovery (e.g., `3`) |
| `successThreshold` | number | ❌ | Successes needed to close circuit (default: `2`) |
| `monitoringPeriod` | number | ❌ | Time window to count failures in ms (default: `60000`) |

### How It Works (3 States)

```
 CLOSED ──(5 failures)──→ OPEN ──(wait 60s)──→ HALF_OPEN
   ↑                                              │
   └──────────(2 successes)────────────────────────┘
   
CLOSED    = Normal, all requests go through
OPEN      = Failing, returns 503 immediately (fast fail)
HALF_OPEN = Testing, sends a few requests to check if backend recovered
```

### Example 1: Basic Circuit Breaker

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://api.example.com",
      "circuitBreaker": "default"
    }
  ],
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
  },
  "version": "2.0"
}
```

**What happens:**
1. Backend returns 5 errors (500, 502, 503, etc.) → circuit **opens**
2. For the next 60 seconds, all requests get instant `503 Service Unavailable`
3. After 60 seconds, circuit goes to **half-open** — sends 3 test requests
4. If 2 of those succeed → circuit **closes**, normal traffic resumes
5. If tests fail → circuit goes back to **open** for another 60 seconds

### Example 2: Multiple Profiles (Sensitive vs. Resilient)

```json
{
  "routes": [
    {
      "prefix": "/api/payments",
      "target": "https://payments.example.com",
      "circuitBreaker": "sensitive"
    },
    {
      "prefix": "/api/search",
      "target": "https://search.example.com",
      "circuitBreaker": "tolerant"
    }
  ],
  "features": {
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "sensitive": {
          "failureThreshold": 2,
          "timeout": 120000,
          "halfOpenAttempts": 1,
          "successThreshold": 1,
          "monitoringPeriod": 30000
        },
        "tolerant": {
          "failureThreshold": 10,
          "timeout": 30000,
          "halfOpenAttempts": 5,
          "successThreshold": 3,
          "monitoringPeriod": 120000
        }
      }
    }
  },
  "version": "2.0"
}
```

| Profile | Opens After | Recovery Wait | Philosophy |
|---------|-------------|---------------|------------|
| `sensitive` | 2 failures in 30s | 2 minutes | Payments — fail fast, don't risk money |
| `tolerant` | 10 failures in 2 min | 30 seconds | Search — occasional errors are OK |

### Monitoring Circuit Breakers

```bash
# Check status
curl https://your-worker.workers.dev/admin/circuit-breaker-status \
  -H "X-Admin-Key: your-key"

# Manually reset (force close)
curl -X POST "https://your-worker.workers.dev/admin/circuit-breaker-reset?backend=https://api.example.com" \
  -H "X-Admin-Key: your-key"
```

---

## Feature: Request Deduplication

**What it does:** If 100 users request the same URL at the exact same moment, only 1 request goes to the backend. The other 99 wait and receive a copy of the same response.

**When to use:** Popular endpoints, dashboards, search results — anywhere many people request the same thing simultaneously.

### Deduplication Profile Settings

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `windowMs` | number | ❌ | How long to group identical requests (default: `5000` = 5 seconds) |

### Example: Basic Deduplication

```json
{
  "routes": [
    {
      "prefix": "/api/trending",
      "target": "https://api.example.com/trending",
      "deduplication": "default"
    },
    {
      "prefix": "/api/dashboard",
      "target": "https://api.example.com/dashboard",
      "deduplication": "tight"
    }
  ],
  "features": {
    "deduplication": {
      "enabled": true,
      "profiles": {
        "default": {
          "windowMs": 5000
        },
        "tight": {
          "windowMs": 1000
        }
      }
    }
  },
  "version": "2.0"
}
```

**Note:** Only applies to GET requests. POST/PUT/DELETE are never deduplicated.

---

## Feature: Request Size Limits

**What it does:** Rejects requests that are too large before they reach your backend. Protects against oversized payloads, extremely long URLs, or excessive headers.

**When to use:** APIs that accept user input, file uploads with size limits, any endpoint exposed to the public internet.

### Size Limits Profile Settings

| Setting | Type | Description |
|---------|------|-------------|
| `maxBodySize` | number | Max request body in bytes (e.g., `5242880` = 5 MB) |
| `maxUrlLength` | number | Max URL length in characters (e.g., `4096`) |
| `maxHeaderSize` | number | Max total header size in bytes (e.g., `8192` = 8 KB) |
| `maxHeaderCount` | number | Max number of headers (e.g., `50`) |

### Special: Default Profile

Size limits has a special `default` field that applies to **all routes** (even those without a `sizeLimits` reference), as long as the feature is enabled.

```json
{
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
        "strict": {
          "maxBodySize": 1048576,
          "maxUrlLength": 2048,
          "maxHeaderSize": 4096,
          "maxHeaderCount": 30
        },
        "upload": {
          "maxBodySize": 104857600,
          "maxUrlLength": 8192,
          "maxHeaderSize": 16384,
          "maxHeaderCount": 100
        }
      }
    }
  }
}
```

### Example: Different Limits Per Route

```json
{
  "routes": [
    {
      "prefix": "/api/admin",
      "target": "https://admin.example.com",
      "sizeLimits": "strict"
    },
    {
      "prefix": "/api/upload",
      "target": "https://upload.example.com",
      "sizeLimits": "upload"
    },
    {
      "prefix": "/api",
      "target": "https://api.example.com"
    }
  ],
  "features": {
    "sizeLimits": {
      "enabled": true,
      "default": {
        "maxBodySize": 10485760,
        "maxUrlLength": 8192
      },
      "profiles": {
        "strict": {
          "maxBodySize": 1048576,
          "maxUrlLength": 2048,
          "maxHeaderSize": 4096,
          "maxHeaderCount": 30
        },
        "upload": {
          "maxBodySize": 104857600
        }
      }
    }
  },
  "version": "2.0"
}
```

| Route | Profile | Max Body | Why |
|-------|---------|----------|-----|
| `/api/admin` | `strict` | 1 MB | Admin API — small JSON only |
| `/api/upload` | `upload` | 100 MB | File uploads |
| `/api` | (uses `default`) | 10 MB | General API — reasonable limit |

### Error Responses

```
413 Payload Too Large  — "Request body size 52428800 bytes exceeds limit of 10485760 bytes"
414 URI Too Long       — "URL length exceeds limit of 8192 characters"
431 Headers Too Large  — "Header count 120 exceeds limit of 100"
```

---

## Feature: Metrics

**What it does:** Collects statistics about every request — counts, latency percentiles, error rates, cache performance.

**When to use:** Always recommended in production for monitoring.

### Example

```json
{
  "features": {
    "metrics": {
      "enabled": true
    }
  }
}
```

**That's it!** No profiles needed — metrics is a simple on/off toggle.

### Viewing Metrics

```bash
# Last 1 minute
curl "https://your-worker.workers.dev/admin/metrics?window=1m" \
  -H "X-Admin-Key: your-key"

# Last 5 minutes
curl "https://your-worker.workers.dev/admin/metrics?window=5m" \
  -H "X-Admin-Key: your-key"

# All time (since last deploy/cold start)
curl "https://your-worker.workers.dev/admin/metrics?window=all" \
  -H "X-Admin-Key: your-key"
```

### Metrics Response

```json
{
  "success": true,
  "metrics": {
    "requests": { "total": 1523, "success": 1498, "errors": 25 },
    "latency":  { "p50": 45, "p95": 120, "p99": 250, "avg": 58.3 },
    "rateLimit": { "blocked": 15, "allowed": 1508 },
    "cache":     { "hits": 850, "misses": 648 },
    "window": "1m"
  }
}
```

---

## Rate Limiting

Rate limiting is a **global setting** (not a feature profile). It limits how many requests each IP address can make.

### Settings

| Setting | Type | Description |
|---------|------|-------------|
| `enabled` | boolean | Turn rate limiting on/off |
| `requestsPerWindow` | number | Base limit per IP (e.g., `300`) |
| `windowSeconds` | number | Time window in seconds (e.g., `300` = 5 minutes) |

Per-route `rateLimitMultiplier` adjusts the limit for specific routes.

### Example 1: Basic Rate Limiting

```json
{
  "routes": [
    { "prefix": "/api", "target": "https://api.example.com" }
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 100,
    "windowSeconds": 60
  },
  "version": "2.0"
}
```

**Result:** Each IP can make 100 requests per minute across all routes.

### Example 2: Per-Route Limits

```json
{
  "routes": [
    {
      "prefix": "/api/search",
      "target": "https://search.example.com",
      "rateLimitMultiplier": 0.2
    },
    {
      "prefix": "/api/public",
      "target": "https://api.example.com",
      "rateLimitMultiplier": 3.0
    },
    {
      "prefix": "/api",
      "target": "https://api.example.com"
    }
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 100,
    "windowSeconds": 60
  },
  "version": "2.0"
}
```

| Route | Multiplier | Effective Limit | Why |
|-------|-----------|-----------------|-----|
| `/api/search` | 0.2 | 20/min | Search is expensive — limit it |
| `/api/public` | 3.0 | 300/min | Public data is cheap — allow more |
| `/api` | 1.0 (default) | 100/min | Standard limit |

**Responses when rate limited:**
- All users → `403 Forbidden` (silent, no body) or `429 Too Many Requests` with `Retry-After` header

---

## Security: Authentication

> **Authentication support coming soon.**

---

## Security: Origin Control

### Allowed Origins (Whitelist)

```json
{
  "allowedOrigins": [
    "https://myapp.example.com",
    "https://admin.example.com",
    "*.example.com",
    "http://localhost:3000"
  ],
  "originChecksEnabled": true
}
```

- Only requests from these origins are allowed
- Supports wildcards: `*.example.com` matches any subdomain
- `originChecksEnabled: false` disables this check entirely
- Requests without an `Origin` header (curl, server-to-server) are always allowed

### Blocked Origins (Blacklist)

```json
{
  "blockedOrigins": [
    "malicious-site.com",
    "spam-bot.example.net"
  ]
}
```

Blocks requests from these origins regardless of other settings.

---

## Combining Features

Features work together seamlessly. Here are common combinations:

### Combo 1: Cache + Deduplication (Read-Heavy API)

```json
{
  "routes": [
    {
      "prefix": "/api/products",
      "target": "https://api.example.com/products",
      "cache": "default",
      "deduplication": "default"
    }
  ],
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "default": { "ttl": 300 }
      }
    },
    "deduplication": {
      "enabled": true,
      "profiles": {
        "default": { "windowMs": 5000 }
      }
    }
  },
  "version": "2.0"
}
```

**How they work together:**
1. Request comes in → check cache → miss
2. While fetching from backend, 50 more identical requests arrive → deduplication groups them
3. Backend responds → response sent to all 51 clients → response cached
4. Next request → served from cache instantly

### Combo 2: Circuit Breaker + Cache (High Availability)

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://api.example.com",
      "cache": "with-stale",
      "circuitBreaker": "default"
    }
  ],
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "with-stale": {
          "ttl": 300,
          "staleWhileRevalidate": 3600
        }
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "default": {
          "failureThreshold": 5,
          "timeout": 60000,
          "halfOpenAttempts": 3
        }
      }
    }
  },
  "version": "2.0"
}
```

**If the backend goes down:**
1. Circuit breaker opens after 5 failures
2. Cached responses (even stale ones up to 1 hour old) are still served
3. Users see slightly old data instead of errors

### Combo 3: Rate Limiting + Size Limits + Metrics (Security Hardened)

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://api.example.com",
      "sizeLimits": "standard"
    }
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 200,
    "windowSeconds": 300
  },
  "features": {
    "sizeLimits": {
      "enabled": true,
      "profiles": {
        "standard": {
          "maxBodySize": 5242880,
          "maxUrlLength": 4096,
          "maxHeaderSize": 8192,
          "maxHeaderCount": 50
        }
      }
    },
    "metrics": {
      "enabled": true
    }
  },
  "version": "2.0"
}
```

### Combo 4: All Features Together (Full Protection)

```json
{
  "routes": [
    {
      "prefix": "/api",
      "target": "https://api.example.com",
      "cache": "default",
      "circuitBreaker": "default",
      "deduplication": "default",
      "sizeLimits": "standard"
    }
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 300,
    "windowSeconds": 300
  },
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "default": { "ttl": 300, "staleWhileRevalidate": 60 }
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "default": { "failureThreshold": 5, "timeout": 60000, "halfOpenAttempts": 3 }
      }
    },
    "deduplication": {
      "enabled": true,
      "profiles": {
        "default": { "windowMs": 5000 }
      }
    },
    "sizeLimits": {
      "enabled": true,
      "profiles": {
        "standard": { "maxBodySize": 5242880, "maxUrlLength": 4096 }
      }
    },
    "metrics": {
      "enabled": true
    }
  },
  "version": "2.0"
}
```

---

## Real-World Examples

### Example A: E-Commerce API

An online store with products, search, checkout, and static assets — each needing different treatment.

```json
{
  "routes": [
    {
      "prefix": "/api/checkout",
      "target": "https://checkout.mystore.com",
      "rateLimitMultiplier": 0.3,
      "circuitBreaker": "sensitive",
      "sizeLimits": "strict"
    },
    {
      "prefix": "/api/products",
      "target": "https://catalog.mystore.com",
      "cache": "products",
      "deduplication": "default",
      "circuitBreaker": "tolerant"
    },
    {
      "prefix": "/api/search",
      "target": "https://search.mystore.com",
      "cache": "search",
      "deduplication": "tight",
      "rateLimitMultiplier": 0.5
    },
    {
      "prefix": "/static",
      "target": "https://cdn.mystore.com",
      "cache": "static",
      "rateLimitMultiplier": 10.0
    }
  ],
  "allowedOrigins": [
    "https://mystore.com",
    "*.mystore.com",
    "http://localhost:3000"
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 200,
    "windowSeconds": 300
  },
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "products": {
          "ttl": 600,
          "staleWhileRevalidate": 120,
          "respectCacheControl": true
        },
        "search": {
          "ttl": 60,
          "varyBy": ["Accept-Language"]
        },
        "static": {
          "ttl": 86400,
          "respectCacheControl": false
        }
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "sensitive": {
          "failureThreshold": 2,
          "timeout": 120000,
          "halfOpenAttempts": 1,
          "successThreshold": 1
        },
        "tolerant": {
          "failureThreshold": 10,
          "timeout": 30000,
          "halfOpenAttempts": 5,
          "successThreshold": 3
        }
      }
    },
    "deduplication": {
      "enabled": true,
      "profiles": {
        "default": { "windowMs": 5000 },
        "tight": { "windowMs": 2000 }
      }
    },
    "sizeLimits": {
      "enabled": true,
      "default": {
        "maxBodySize": 5242880,
        "maxUrlLength": 8192
      },
      "profiles": {
        "strict": {
          "maxBodySize": 1048576,
          "maxUrlLength": 2048,
          "maxHeaderSize": 4096,
          "maxHeaderCount": 30
        }
      }
    },
    "metrics": {
      "enabled": true
    }
  },
  "version": "2.0"
}
```

**Why each route is configured this way:**

| Route | Features | Reasoning |
|-------|----------|-----------|
| `/api/checkout` | Sensitive circuit breaker + strict size limits + low rate limit | Money is involved — maximum security |
| `/api/products` | Cache + dedup + tolerant circuit breaker | Read-heavy, occasional errors OK |
| `/api/search` | Short cache + tight dedup + low rate limit | Expensive queries, deduplicate aggressively |
| `/static` | Long cache + high rate limit | Static files — cache forever, allow many requests |

### Example B: Microservices Gateway

Route to different internal services based on URL path.

```json
{
  "routes": [
    { "prefix": "/auth",     "target": "https://auth.internal.com",     "circuitBreaker": "critical" },
    { "prefix": "/users",    "target": "https://users.internal.com",    "circuitBreaker": "standard", "cache": "short" },
    { "prefix": "/orders",   "target": "https://orders.internal.com",   "circuitBreaker": "critical" },
    { "prefix": "/search",   "target": "https://search.internal.com",   "cache": "search", "deduplication": "default" },
    { "prefix": "/docs",     "target": "https://docs.internal.com",     "cache": "static" }
  ],
  "rateLimit": {
    "enabled": true,
    "requestsPerWindow": 500,
    "windowSeconds": 60
  },
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "short":  { "ttl": 60 },
        "search": { "ttl": 30, "varyBy": ["Accept-Language"] },
        "static": { "ttl": 3600 }
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "critical": { "failureThreshold": 3,  "timeout": 60000,  "halfOpenAttempts": 2 },
        "standard": { "failureThreshold": 10, "timeout": 30000,  "halfOpenAttempts": 5 }
      }
    },
    "deduplication": {
      "enabled": true,
      "profiles": {
        "default": { "windowMs": 3000 }
      }
    },
    "metrics": { "enabled": true }
  },
  "version": "2.0"
}
```

### Example C: Simple Proxy (No Features)

```json
{
  "routes": [
    { "prefix": "/v2", "target": "https://api-v2.example.com" },
    { "prefix": "/v1", "target": "https://api-v1.example.com" },
    { "prefix": "/",   "target": "https://api-v2.example.com" }
  ],
  "version": "2.0"
}
```

Zero features enabled. Just routes. Everything else is off by default.

### Example D: API with Load Balancing and Geo-Routing

```json
{
  "routes": [
    { "prefix": "/us/api",   "target": "https://us-east.example.com",  "cache": "default", "circuitBreaker": "default" },
    { "prefix": "/eu/api",   "target": "https://eu-west.example.com",  "cache": "default", "circuitBreaker": "default" },
    { "prefix": "/asia/api", "target": "https://asia-pac.example.com", "cache": "default", "circuitBreaker": "default" }
  ],
  "features": {
    "cache": {
      "enabled": true,
      "profiles": {
        "default": { "ttl": 120, "staleWhileRevalidate": 60 }
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "profiles": {
        "default": { "failureThreshold": 5, "timeout": 30000, "halfOpenAttempts": 3 }
      }
    }
  },
  "version": "2.0"
}
```

---

## Uploading Your Config

### Step 1: Save your config as `config.json`

### Step 2: Upload to KV

```bash
pnpm exec wrangler kv key put \
  --namespace-id=YOUR_PROXY_CONFIG_KV_ID \
  "config" \
  --path=config.json \
  --remote
```

### Step 3: Flush the cache (so changes take effect immediately)

```bash
curl -X POST https://your-worker.workers.dev/admin/cache-flush \
  -H "X-Admin-Key: your-admin-key"
```

### Step 4: Verify

```bash
# Check config was uploaded
pnpm exec wrangler kv key get \
  --namespace-id=YOUR_PROXY_CONFIG_KV_ID \
  "config" --remote | jq .

# Test a route
curl https://your-worker.workers.dev/api/health
```

**Note:** Config is cached in-memory for 12 hours. Always flush after uploading changes, or redeploy the worker.

---

## Troubleshooting

### "My cache isn't working"

1. Is `features.cache.enabled` set to `true`? (Not just the profile)
2. Does the route have `"cache": "profileName"`?
3. Does the profile name match exactly? (Case-sensitive)
4. Only GET requests are cached — POST/PUT/DELETE are never cached
5. Is the backend sending `Cache-Control: no-store`? Set `respectCacheControl: false` to override
6. Check cache stats:
   ```bash
   curl https://your-worker.workers.dev/admin/cache-stats \
     -H "X-Admin-Key: your-key"
   ```

### "I get 503 Service Unavailable"

1. Check if circuit breaker is open:
   ```bash
   curl https://your-worker.workers.dev/admin/circuit-breaker-status \
     -H "X-Admin-Key: your-key"
   ```
2. Reset it manually:
   ```bash
   curl -X POST "https://your-worker.workers.dev/admin/circuit-breaker-reset?backend=https://..." \
     -H "X-Admin-Key: your-key"
   ```
3. Or increase `failureThreshold` if the backend has occasional errors

### "Rate limiting is too aggressive"

1. Increase `requestsPerWindow`
2. Add `rateLimitMultiplier: 2.0` to specific routes that need more headroom
3. Add `rateLimitMultiplier: 2.0` to routes that need more headroom

### "Config changes aren't taking effect"

Config is cached for 12 hours. After uploading, always flush:
```bash
curl -X POST https://your-worker.workers.dev/admin/cache-flush \
  -H "X-Admin-Key: your-key"
```

### "Feature is enabled but not working on a route"

Remember the two-level system. All three must be true:
1. ✅ `features.<name>.enabled: true` — global switch is on
2. ✅ Route has `"<name>": "profileName"` — route opts in
3. ✅ Profile name exists in `features.<name>.profiles` — profile is defined

### "413 Payload Too Large"

Increase size limits for that route:
```json
{
  "features": {
    "sizeLimits": {
      "enabled": true,
      "profiles": {
        "large-upload": { "maxBodySize": 104857600 }
      }
    }
  },
  "routes": [
    { "prefix": "/upload", "target": "...", "sizeLimits": "large-upload" }
  ]
}
```

---

## Complete Config Reference

```json
{
  "routes": [
    {
      "prefix": "/path",              // REQUIRED: URL prefix to match
      "target": "https://...",         // REQUIRED: Backend URL
      "rateLimitMultiplier": 1.0,      // Scale rate limit (default: 1.0)
      "cache": "profileName",          // Cache profile name (optional)
      "circuitBreaker": "profileName", // Circuit breaker profile (optional)
      "deduplication": "profileName",  // Dedup profile (optional)
      "sizeLimits": "profileName"      // Size limits profile (optional)
    }
  ],
  "features": {
    "cache": {
      "enabled": false,
      "profiles": {
        "profileName": {
          "ttl": 300,
          "varyBy": [],
          "bypassHeader": "X-No-Cache",
          "staleWhileRevalidate": 0,
          "respectCacheControl": true,
          "cacheableStatusCodes": [200, 301, 404]
        }
      }
    },
    "circuitBreaker": {
      "enabled": false,
      "profiles": {
        "profileName": {
          "failureThreshold": 5,
          "timeout": 60000,
          "halfOpenAttempts": 3,
          "successThreshold": 2,
          "monitoringPeriod": 60000
        }
      }
    },
    "deduplication": {
      "enabled": false,
      "profiles": {
        "profileName": {
          "windowMs": 5000
        }
      }
    },
    "sizeLimits": {
      "enabled": false,
      "default": {
        "maxBodySize": 10485760,
        "maxUrlLength": 8192,
        "maxHeaderSize": 16384,
        "maxHeaderCount": 100
      },
      "profiles": {
        "profileName": {
          "maxBodySize": 10485760,
          "maxUrlLength": 8192,
          "maxHeaderSize": 16384,
          "maxHeaderCount": 100
        }
      }
    },
    "metrics": {
      "enabled": false
    }
  },
  "rateLimit": {
    "enabled": false,
    "requestsPerWindow": 300,
    "windowSeconds": 300
  },
  "allowedOrigins": [],
  "blockedOrigins": [],
  "originChecksEnabled": true,
  "turnstileSecretKey": "",
  "version": "2.0"
}
```

### Environment Variables (wrangler.toml)

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUEST_TIMEOUT` | `120000` | Backend request timeout in ms |
| `CACHE_TTL` | `43200000` | Config cache TTL in ms (12 hours) |
| `ADMIN_KEY` | _(none)_ | Key for admin endpoints (`X-Admin-Key` header) |
| `LOG_LEVEL` | `INFO` | Log filtering: `DEBUG`, `INFO`, `WARN`, `ERROR`, `NONE` |

---

*Last updated for Proxy Load Balancer v2.0*
