## Plan: Cloudflare Worker Proxy Load Balancer with Hono (Final)

**TL;DR:** Build a Hono-based proxy that matches request paths using first-registered prefix rules, rewrites URLs, and streams requests/responses with all headers intact. Cache KV config for 12 hours with admin flush endpoint. Return 503 (service unavailable) or 504 (timeout) on backend failure with error details. Single backend per route prefix; query strings always preserved.

### Steps

1. **Initialize project with Wrangler and Hono.** Create [package.json](package.json), [tsconfig.json](tsconfig.json), and [wrangler.toml](wrangler.toml) with Hono, KV bindings, and configurable timeout (default 120s).

2. **Design KV config structure** in [config.ts](src/config.ts): JSON with ordered routes (first-match-wins). Format: `{ "routes": [{ "prefix": "/api/v1/user", "target": "https://backend-1.com" }, ...], "version": "1.0" }`. Implement in-memory cache with 12-hour TTL metadata.

3. **Build KV config loader** in [config.ts](src/config.ts) that checks in-memory cache expiration on every request. Refetch from KV if expired. Gracefully handle parsing errors with fallback empty config.

4. **Implement admin flush cache endpoint** (`POST /admin/cache-flush`) in [index.ts](src/index.ts) that clears in-memory cache and forces next request to refetch from KV.

5. **Create route matching middleware** in [router.ts](src/router.ts) using Hono's `app.use('/api/*', ...)` that iterates config routes in order, matches incoming path against prefixes (first-registered wins), and stores matched route info in context.

6. **Implement URL rewriting** in [router.ts](src/router.ts): extract matched prefix and remaining path. Reconstruct target URL without prefix, preserve query parameters. Example: `/api/v1/user/123?page=1` → `https://backend-1.com/user/123?page=1`.

7. **Stream request/response forwarding** in [router.ts](src/router.ts): forward all headers (Host, Authorization, Cookies, etc.) as-is. Add `X-Forwarded-For` and `X-Forwarded-Proto` headers. Use request body streaming to avoid buffering. Stream response directly without buffering.

8. **Add error handling** in [router.ts](src/router.ts): catch timeouts (return 504 with error message), backend errors (return 503 with error details). Append error stack/message to response body for analysis.

9. **Implement structured logging** in [logger.ts](src/logger.ts) capturing: timestamp, request path/method, matched prefix/target, HTTP status, response time, timeout flag, error message.

10. **Add timeout configuration** in [wrangler.toml](wrangler.toml) and [config.ts](src/config.ts): read configurable timeout (default 120s), apply to all backend requests via fetch AbortController.

11. **Document deployment**: Example KV config JSON, wrangler CLI commands to publish KV data, and deployment instructions in [README.md](README.md).

### Concerns & Clarifications

No remaining concerns. All decisions finalized:
- ✅ Query strings preserved automatically (URL-based routing)
- ✅ First-registered route matching (simplest, no longest-prefix complexity)
- ✅ All headers forwarded with X-Forwarded-* additions
- ✅ Admin `/admin/cache-flush` endpoint for manual cache invalidation
- ✅ 503/504 errors with error message appended to response
- ✅ Response streaming handled by Hono automatically
- ✅ Single backend per prefix (no round-robin load balancing)

**Ready to implement when confirmed.**
