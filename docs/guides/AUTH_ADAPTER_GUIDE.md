# Auth Adapter Integration Guide

> **Who this is for:** Developers (including interns) who want to protect proxy routes with authentication, or build a custom integration with their own auth service.

---

## Table of Contents

1. [How the Auth System Works](#1-how-the-auth-system-works)
2. [Protecting a Route (5 Minutes)](#2-protecting-a-route-5-minutes)
3. [Using the Built-in JWT Adapter](#3-using-the-built-in-jwt-adapter)
4. [Using the Built-in Forward-Auth Adapter](#4-using-the-built-in-forward-auth-adapter)
5. [Writing Your Own Custom Adapter](#5-writing-your-own-custom-adapter)
6. [The Supabase Example Adapter](#6-the-supabase-example-adapter)
7. [Auth Caching](#7-auth-caching)
8. [Testing Your Adapter Locally](#8-testing-your-adapter-locally)
9. [Troubleshooting](#9-troubleshooting)
10. [Complete Config Reference](#10-complete-config-reference)

---

## 1. How the Auth System Works

Before writing any code, here's the 30-second mental model:

```
Incoming Request
      │
      ▼
[Rate Limit] → [Route Match] → [Auth Check ← YOU ARE HERE] → [Backend]
```

When a request hits a protected route, the proxy:

1. **Looks up the route's auth profile** in `config.json` (e.g. `"auth": "my-profile"`)
2. **Finds the adapter** registered under that profile's `"adapter"` name
3. **Optionally checks the cache** — if the token was verified recently, skip the call
4. **Calls `adapter.verify()`** — your code runs here
5. **If success:** injects any `upstreamHeaders` into the backend request and continues
6. **If failure:** returns the response your adapter provided (or a plain 401)

The proxy never knows *how* you verify — it only cares about the `AuthResult` you return.

---

## 2. Protecting a Route (5 Minutes)

This is the minimal setup using the built-in `jwt` adapter.

### Step 1 — Enable auth in `config.json`

```json
{
  "routes": [
    {
      "prefix": "/api/private",
      "target": "https://your-backend.com",
      "auth": "require-jwt"
    },
    {
      "prefix": "/api/public",
      "target": "https://your-backend.com"
    }
  ],
  "features": {
    "auth": {
      "enabled": true,
      "profiles": {
        "require-jwt": {
          "adapter": "jwt",
          "jwksUrl": "https://your-auth-provider.com/.well-known/jwks.json",
          "audience": "your-api-name",
          "issuer": "https://your-auth-provider.com"
        }
      }
    }
  },
  "version": "2.0"
}
```

**What this does:**
- `/api/private/*` — requires a valid JWT in the `Authorization: Bearer <token>` header
- `/api/public/*` — no auth required (no `"auth"` key on the route)

### Step 2 — Upload and apply config

```bash
pnpm exec wrangler kv key put \
  --namespace-id=YOUR_PROXY_CONFIG_ID \
  "config" \
  --path=config.json \
  --remote

curl -X POST https://your-worker.workers.dev/admin/cache-flush \
  -H "X-Admin-Key: $ADMIN_KEY"
```

### Step 3 — Test it

```bash
# Should get 401
curl https://your-worker.workers.dev/api/private/data

# Should get proxied response
curl https://your-worker.workers.dev/api/private/data \
  -H "Authorization: Bearer YOUR_VALID_JWT"
```

That's it. No code changes needed for built-in adapters.

---

## 3. Using the Built-in JWT Adapter

The `jwt` adapter validates JSON Web Tokens. It supports:
- **RS256 / ES256** — using a JWKS endpoint (most auth providers)
- **HS256** — using a shared secret

### 3.1 JWKS (Auth0, Clerk, Keycloak, Supabase, etc.)

```json
"require-jwt": {
  "adapter": "jwt",
  "jwksUrl": "https://YOUR_DOMAIN/.well-known/jwks.json",
  "audience": "YOUR_API_IDENTIFIER",
  "issuer":   "https://YOUR_DOMAIN/"
}
```

> **Where to find these values:**
> - **Auth0:** Dashboard → APIs → your API → Settings tab
> - **Clerk:** Dashboard → JWT Templates → your template
> - **Supabase:** Settings → API → JWT Settings (use `jwksUrl` or the `secret` field below)

### 3.2 Shared Secret (HS256)

```json
"require-jwt": {
  "adapter": "jwt",
  "secret": "your-very-long-random-secret-here",
  "audience": "optional-audience",
  "issuer":   "optional-issuer"
}
```

> ⚠️ Never commit the secret to git. Store it in KV config only.

### 3.3 Token Extraction Options

By default the adapter reads `Authorization: Bearer <token>`. You can change this:

```json
"require-jwt": {
  "adapter": "jwt",
  "secret": "...",
  "tokenExtraction": {
    "type": "cookie",
    "name": "session_token"
  }
}
```

| `type` | Reads from | `name` field |
|---|---|---|
| `"header"` *(default)* | `Authorization: Bearer <token>` | Header name (default: `Authorization`) |
| `"custom-header"` | Any header, value used directly | Header name (default: `X-Auth-Token`) |
| `"cookie"` | Named cookie | Cookie name (default: `token`) |
| `"query"` | URL query param | Param name (default: `token`) |

### 3.4 What Gets Forwarded to Your Backend

On successful verification, these headers are added to the upstream request:

| Header | Value |
|---|---|
| `X-User-Id` | JWT `sub` claim (user ID) |
| `X-User-Email` | JWT `email` claim (if present) |

Your backend can read these to identify the user without re-verifying the token.

---

## 4. Using the Built-in Forward-Auth Adapter

Use `forward-auth` when you have an existing auth service and want the proxy to call it for every request.

### How it works

```
Request → Proxy → (1) subrequest to your auth URL
                      ├── 2xx → pass through, continue to backend
                      └── non-2xx → return auth service response to client
```

### Config

```json
"require-session": {
  "adapter": "forward-auth",
  "url": "https://auth.your-company.com/verify",
  "forwardHeaders": ["Authorization", "Cookie"],
  "upstreamHeaders": ["X-User-Id", "X-User-Role", "X-Org-Id"]
}
```

| Field | Required | Description |
|---|---|---|
| `url` | ✅ | URL of your auth service verification endpoint |
| `forwardHeaders` | No | Headers from the client request to send to auth service (default: `["Authorization"]`) |
| `upstreamHeaders` | No | Headers from the auth response to inject into the backend request |

### What your auth service receives

```
GET https://auth.your-company.com/verify
Authorization: Bearer <client's token>
X-Forwarded-Uri: https://proxy.example.com/api/private/data
X-Forwarded-Method: GET
```

### What your auth service should return

- **Any 2xx status** → auth passes
- **Any other status** → that exact response (status + headers + body) is returned to the client

This means your auth service can return:
- `401 Unauthorized` with a JSON body
- `403 Forbidden` for insufficient permissions
- `302 Found` to redirect to a login page

---

## 5. Writing Your Own Custom Adapter

When the built-in adapters don't fit (custom session store, vendor-specific API, multi-step validation), write your own.

### Step 1 — Create the adapter file

Create `src/auth/adapters/my-adapter.ts`:

```typescript
import type { AuthAdapter, AuthResult } from '../../types/auth';
import type { Env } from '../../config';

// Define the shape of your profile config
interface MyAdapterConfig {
  apiUrl: string;
  apiKey?: string;
  [key: string]: unknown;
}

export const myAdapter: AuthAdapter = {
  // This name must match "adapter": "my-adapter" in config.json
  name: 'my-adapter',

  /**
   * Return a string that uniquely identifies this auth request for caching.
   * Return null if this request should never be cached.
   *
   * Good cache keys: the token itself, a session ID header, an API key header.
   * Bad cache keys: the full URL (varies per request but same identity).
   */
  cacheKey(request: Request, config: Record<string, unknown>): string | null {
    return request.headers.get('Authorization');
  },

  /**
   * Verify the request. This is where your auth logic lives.
   *
   * @param request   The incoming request — read headers, but do NOT read the body
   *                  (it's a stream and reading it here would break the proxy)
   * @param config    The raw profile object from config.json — your adapter-specific fields
   * @param env       Cloudflare Worker bindings (KV, secrets, etc.)
   * @param ctx       Worker execution context — use ctx.waitUntil() for background tasks
   */
  async verify(
    request: Request,
    config: Record<string, unknown>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<AuthResult> {
    const cfg = config as MyAdapterConfig;

    // 1. Extract the token / credential from the request
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'Authorization header is required' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    // 2. Verify it (call your API, validate a signature, check a database, etc.)
    let user: { id: string; role: string };
    try {
      const res = await fetch(`${cfg.apiUrl}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {}),
        },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        // Return the auth service's response directly (full control over error format)
        return { success: false, response: res };
      }

      user = await res.json() as { id: string; role: string };
    } catch {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'Auth service unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    // 3. Return success with any headers to inject into the backend request
    return {
      success: true,
      upstreamHeaders: {
        'X-User-Id':   user.id,
        'X-User-Role': user.role,
      },
    };
  },
};
```

### Step 2 — Register the adapter

Open `src/auth/adapters/index.ts` and add two lines:

```typescript
// ...existing registrations...

import { myAdapter } from './my-adapter';   // ← add this
registerAdapter(myAdapter);                  // ← add this
```

### Step 3 — Add a profile in `config.json`

```json
"features": {
  "auth": {
    "enabled": true,
    "profiles": {
      "my-profile": {
        "adapter": "my-adapter",
        "apiUrl": "https://auth.your-company.com",
        "apiKey": "secret-key-here"
      }
    }
  }
}
```

### Step 4 — Reference on a route

```json
{
  "prefix": "/api/private",
  "target": "https://backend.com",
  "auth": "my-profile"
}
```

### Step 5 — Deploy

```bash
pnpm run deploy
```

---

### The AuthResult contract

| Field | Type | When to use |
|---|---|---|
| `success: true` | — | Auth passed — request continues to backend |
| `upstreamHeaders` | `Record<string, string>` | Headers to inject into the backend request (user ID, roles, etc.) |
| `success: false` | — | Auth failed |
| `response` | `Response` | The exact response returned to the client. If omitted, a plain `401 Unauthorized` is returned. |

> **Tip:** Your adapter has full control over the failure response. Return a `302` to redirect to a login page, a `403` for insufficient permissions, or a JSON body matching your API's error format.

---

## 6. The Supabase Example Adapter

A complete real-world example is included at `src/auth/adapters/supabase.ts`. It's a great template to copy from.

### What it does

- Validates Supabase access tokens using your **JWT secret** (fast, no external calls)
- Optionally switches to **API verification** (`verifyViaApi: true`) for always-fresh checks
- Returns Supabase-style error JSON (`{ "message": "...", "hint": "..." }`)
- Rejects anonymous tokens (`role: "anon"`) — only authenticated sessions pass
- Forwards `X-User-Id`, `X-User-Email`, `X-User-Role` to your backend

### Setup

**1. Find your JWT secret**

Go to your Supabase project → **Settings** → **API** → copy **JWT Secret**.

**2. Enable the adapter**

In `src/auth/adapters/index.ts`, uncomment:

```typescript
import { supabaseAdapter } from './supabase';
registerAdapter(supabaseAdapter);
```

**3. Add the profile to `config.json`**

```json
"features": {
  "auth": {
    "enabled": true,
    "cache": { "enabled": true, "ttl": 300 },
    "profiles": {
      "supabase": {
        "adapter": "supabase",
        "supabaseUrl": "https://YOUR-PROJECT-ID.supabase.co",
        "supabaseJwtSecret": "your-jwt-secret-from-supabase-dashboard"
      }
    }
  }
}
```

**4. Protect routes**

```json
{
  "prefix": "/api/v1/user",
  "target": "https://your-backend.com",
  "auth": "supabase"
}
```

**5. Use on the client**

```javascript
// Frontend — get the Supabase session token and send it
const { data: { session } } = await supabase.auth.getSession();

const response = await fetch('/api/v1/user/profile', {
  headers: {
    Authorization: `Bearer ${session.access_token}`,
  },
});
```

### API verification mode

Set `"verifyViaApi": true` if you need always-fresh verification (e.g. immediately after a token is revoked):

```json
"supabase-strict": {
  "adapter": "supabase",
  "supabaseUrl": "https://YOUR-PROJECT-ID.supabase.co",
  "verifyViaApi": true
}
```

> **Note:** This makes an HTTP call to Supabase on every request (unless cached). Enable auth caching to reduce latency.

---

## 7. Auth Caching

Verifying a JWT or calling an external service on every request adds latency. Enable caching to verify once and reuse the result.

```json
"features": {
  "auth": {
    "enabled": true,
    "cache": {
      "enabled": true,
      "ttl": 300,
      "kvBinding": "PROXY_AUTH_CACHE"
    },
    "profiles": { ... }
  }
}
```

### How the cache key works

Each adapter controls its own cache key via `cacheKey()`:

- **`jwt` adapter** — the raw token string (already signed and opaque)
- **`forward-auth` adapter** — concatenation of forwarded header values
- **`supabase` adapter** — the raw Bearer token
- **Custom adapter** — whatever you return from `cacheKey()`, or `null` to disable

### Cache key returning `null`

If `cacheKey()` returns `null`, that request is **never cached**. Use this when:
- The credential changes every request (one-time tokens, HMAC-signed requests)
- You need real-time revocation checks on every call

### Setting up the KV namespace

```bash
# Create the namespace
pnpm exec wrangler kv namespace create "PROXY_AUTH_CACHE"

# Copy the returned ID into wrangler.toml:
# [[kv_namespaces]]
# binding = "PROXY_AUTH_CACHE"
# id = "YOUR_RETURNED_ID"
```

> **Alternative:** Set `"kvBinding": "PROXY_CACHE"` to reuse the existing response cache namespace. Auth entries are stored with an `auth:` key prefix to avoid collisions.

### Cache TTL guidance

| Scenario | Recommended TTL |
|---|---|
| Short-lived JWTs (15 min expiry) | 60–180 s |
| Long-lived JWTs (24 h expiry) | 300–600 s |
| Forward-auth to fast internal service | 60–120 s |
| Strict real-time revocation needed | Disable cache (`enabled: false`) |

---

## 8. Testing Your Adapter Locally

### Start the local dev server

```bash
pnpm run dev
# Server starts at http://localhost:8787
```

### Run a basic auth test

```bash
# Expect 401 — no token
curl http://localhost:8787/api/private/test

# Expect proxied response — with valid token
curl http://localhost:8787/api/private/test \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Debugging tips

**1. Add console.log to your adapter during development**

```typescript
async verify(request, config, env, ctx) {
  console.log('[my-adapter] verifying request to', request.url);
  const token = request.headers.get('Authorization');
  console.log('[my-adapter] token present:', !!token);
  // ...
}
```

Logs appear in the `pnpm run dev` terminal.

**2. Check live logs in production**

```bash
pnpm run tail
```

Look for log entries with `"auditType": "AUTH_FAILED"` to see which requests are being rejected and why.

**3. Verify your adapter is registered**

If you get `500 Auth adapter "my-adapter" is not registered`, check:
1. You added `registerAdapter(myAdapter)` in `src/auth/adapters/index.ts`
2. The `name` field in your adapter matches the `"adapter"` field in config exactly (case-sensitive)

---

## 9. Troubleshooting

### `401 Unauthorized` on every request

| Check | How |
|---|---|
| Is `features.auth.enabled` set to `true`? | Check `config.json` |
| Does the route have `"auth": "profile-name"`? | Check the route definition |
| Does the profile name in the route match a key in `profiles`? | Both must be identical strings |
| Is the token being sent correctly? | `curl -v` and check the `Authorization` header |
| Has the config been flushed? | `POST /admin/cache-flush` |

### `500 Auth adapter "X" is not registered`

```typescript
// src/auth/adapters/index.ts
import { myAdapter } from './my-adapter';   // ← did you add this?
registerAdapter(myAdapter);                  // ← and this?
```

Also check: the `name` in your adapter object matches the `"adapter"` string in config.

### Auth passes but backend doesn't see `X-User-Id`

1. Confirm your `verify()` returns `upstreamHeaders: { 'X-User-Id': '...' }`
2. Check that your backend is reading the right header name (case-insensitive in HTTP, but check for typos)
3. The header is set on the **backend request** — it won't appear in the response to the client

### Caching not working (auth called every time)

1. Is `features.auth.cache.enabled` set to `true`?
2. Does the KV binding exist? Run `pnpm exec wrangler kv namespace list` to verify
3. Is `cacheKey()` returning `null`? If so, caching is intentionally disabled for that request
4. Is the KV binding ID correct in `wrangler.toml`?

### Token expired error immediately after login

Your system clock may be skewed. The `jwt` adapter validates `exp` (expiry) and `nbf` (not before) claims using `Date.now()`. Cloudflare Workers use accurate UTC time — check that your token issuer is also UTC.

---

## 10. Complete Config Reference

```jsonc
{
  "routes": [
    {
      "prefix": "/api/protected",
      "target": "https://backend.example.com",
      // Reference a profile name — omit this field to leave the route unprotected
      "auth": "my-profile"
    }
  ],
  "features": {
    "auth": {
      // Master switch — set false to disable auth globally without removing route config
      "enabled": true,

      // Auth decision cache (optional but recommended for performance)
      "cache": {
        "enabled": true,
        // KV namespace to use:
        //   "PROXY_AUTH_CACHE" — dedicated namespace (recommended, cleaner separation)
        //   "PROXY_CACHE"      — reuse response cache namespace (auth keys prefixed with "auth:")
        "kvBinding": "PROXY_AUTH_CACHE",
        // How long to cache a successful auth decision, in seconds
        "ttl": 300
      },

      "profiles": {

        // ── JWT (JWKS, RS256/ES256) ──────────────────────────────────────
        "jwt-jwks": {
          "adapter": "jwt",
          "jwksUrl": "https://auth.example.com/.well-known/jwks.json",
          "audience": "my-api",       // optional — validates JWT "aud" claim
          "issuer":   "https://auth.example.com"  // optional — validates JWT "iss" claim
        },

        // ── JWT (shared secret, HS256) ───────────────────────────────────
        "jwt-secret": {
          "adapter": "jwt",
          "secret": "your-long-random-secret",
          "audience": "my-api",
          "issuer":   "https://auth.example.com",
          // Custom token extraction (default: Authorization: Bearer)
          "tokenExtraction": {
            "type": "cookie",     // "header" | "custom-header" | "cookie" | "query"
            "name": "session"     // header/cookie/param name
          }
        },

        // ── Forward Auth ─────────────────────────────────────────────────
        "forward": {
          "adapter": "forward-auth",
          "url": "https://auth.example.com/verify",
          // Headers from the client request to send to auth service
          "forwardHeaders": ["Authorization", "Cookie"],
          // Headers from auth service response to inject into backend request
          "upstreamHeaders": ["X-User-Id", "X-User-Role", "X-Org-Id"]
        },

        // ── Supabase (local JWT) ─────────────────────────────────────────
        "supabase-local": {
          "adapter": "supabase",
          "supabaseUrl": "https://xxxx.supabase.co",
          "supabaseJwtSecret": "your-supabase-jwt-secret"
        },

        // ── Supabase (API verification) ──────────────────────────────────
        "supabase-strict": {
          "adapter": "supabase",
          "supabaseUrl": "https://xxxx.supabase.co",
          "verifyViaApi": true
        },

        // ── Custom adapter ───────────────────────────────────────────────
        "my-custom": {
          "adapter": "my-adapter",   // must match adapter.name exactly
          "apiUrl": "https://auth.company.com",
          "anyOtherField": "value"   // passed through to your adapter as-is
        }

      }
    }
  }
}
```

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────┐
│  I want to...                    │  Use                  │
├─────────────────────────────────────────────────────────┤
│  Validate a JWT (Auth0/Clerk)    │  adapter: "jwt"       │
│                                  │  + jwksUrl            │
├─────────────────────────────────────────────────────────┤
│  Validate a JWT (shared secret)  │  adapter: "jwt"       │
│                                  │  + secret             │
├─────────────────────────────────────────────────────────┤
│  Delegate to my auth service     │  adapter: "forward-auth"│
│                                  │  + url                │
├─────────────────────────────────────────────────────────┤
│  Integrate with Supabase         │  adapter: "supabase"  │
│                                  │  (uncomment first)    │
├─────────────────────────────────────────────────────────┤
│  Custom logic / vendor API       │  Write a custom       │
│                                  │  adapter (section 5)  │
└─────────────────────────────────────────────────────────┘

Files to know:
  src/auth/adapters/index.ts   ← register adapters HERE
  src/auth/adapters/supabase.ts ← example to copy from
  src/types/auth.ts             ← AuthAdapter interface
  config.json                   ← profiles + route references
```
