# Proxy Load Balancer - Architecture & Flow

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PROXY LOAD BALANCER ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────────────┘

                            ╔════════════════════╗
                            ║   CLIENT REQUEST   ║
                            ║ GET /api/Data/...  ║
                            ╚═════════════╤══════╝
                                          │
                                          ▼
                      ┌───────────────────────────────────────┐
                      │   CLOUDFLARE WORKER (Hono)           │
                      │                                       │
                      │  1. Receive Request                   │
                      │  2. Extract Path: /api/Data/GetVoter  │
                      │  3. Check Admin Endpoints?            │
                      │     - /health  ✓                      │
                      │     - /admin/cache-flush (needs key)  │
                      └───────────────────┬───────────────────┘
                                          │
                        ┌─────────────────┴──────────────────┐
                        │                                    │
                        ▼                                    ▼
           ┌─────────────────────────┐        ┌──────────────────────┐
           │  LOAD CONFIG FROM KV    │        │  CACHE LOOKUP        │
           │                         │        │                      │
           │  Check in-memory cache  │────────│ TTL Valid?           │
           │  (12-hour TTL)          │ YES    │ Return cached config │
           │                         │        └──────────────────────┘
           └────────────┬────────────┘
                        │ NO (expired/missing)
                        ▼
           ┌─────────────────────────────────────┐
           │   Cloudflare KV Namespace           │
           │  ┌───────────────────────────────┐  │
           │  │ Key: "config"                 │  │
           │  │ Value: {                      │  │
           │  │   "routes": [                 │  │
           │  │     {                         │  │
           │  │       "prefix": "/api/Data/..│  │
           │  │       "target": "https://... │  │
           │  │     },                        │  │
           │  │     ...                       │  │
           │  │   ]                           │  │
           │  │ }                             │  │
           │  └───────────────────────────────┘  │
           │         (< 60ms latency)             │
           └────────────┬────────────────────────┘
                        │
                        ▼
           ┌──────────────────────────────────────┐
           │  ROUTE MATCHING (First-Match-Wins)   │
           │                                      │
           │  Request Path:                       │
           │  /api/Data/GetVoterInfoListBy...    │
           │                                      │
           │  Check Routes in Order:              │
           │  ✗ /api/Data/GetUnionOrPouroList    │
           │  ✓ /api/Data/GetVoterInfoListBy...  │
           │                                      │
           │  Matched! ✓                          │
           │  Prefix: /api/Data/GetVoterInfo...  │
           │  Target: https://httpbin.org        │
           │  Remaining Path: ?                   │
           └────────────┬─────────────────────────┘
                        │
                        ▼
           ┌──────────────────────────────────────────┐
           │  URL REWRITING & HEADER SETUP            │
           │                                          │
           │  Original:                               │
           │    /api/Data/GetVoterInfoListBy..?p=1   │
           │                                          │
           │  Rewritten:                              │
           │    https://httpbin.org?p=1               │
           │                                          │
           │  Headers Added:                          │
           │    X-Forwarded-For: <client-ip>          │
           │    X-Forwarded-Proto: https              │
           │    [All original headers preserved]      │
           │                                          │
           │  Body: [Streamed as-is]                  │
           └────────────┬─────────────────────────────┘
                        │
                        ▼
           ┌──────────────────────────────────────┐
           │  PROXY REQUEST TO BACKEND             │
           │                                      │
           │  fetch(                              │
           │    https://httpbin.org?p=1,          │
           │    { method, headers, body,          │
           │      timeout: 120000ms,               │
           │      signal: abortController }       │
           │  )                                   │
           │                                      │
           │  Timeout: 120s (configurable)        │
           └────────────┬─────────────────────────┘
                        │
        ┌───────────────┼───────────────┬──────────────┐
        │               │               │              │
        ▼ (200-299)     ▼ (Timeout)     ▼ (Error)      ▼ (Other)
   ┌─────────┐    ┌──────────┐    ┌──────────┐   ┌──────────┐
   │SUCCESS  │    │  504      │    │  503     │   │ PASSTHRU │
   │         │    │  Gateway  │    │  Service │   │  (4xx,5x)│
   │Stream   │    │  Timeout  │    │Unavailab│   │          │
   │response │    │           │    │          │   │Forward   │
   │directly │    │+ Error msg│    │+Error msg│   │response  │
   └────┬────┘    └──────┬────┘    └────┬─────┘   └────┬─────┘
        │                │              │              │
        └────────────────┴──────────────┴──────────────┘
                         │
                         ▼
           ┌────────────────────────────────────┐
           │  STRUCTURED LOGGING (JSON)         │
           │                                    │
           │  {                                 │
           │    "timestamp": "2026-01-31...",  │
           │    "method": "GET",                │
           │    "path": "/api/Data/GetVoter",  │
           │    "matchedPrefix": "/api/Data..",│
           │    "targetUrl": "https://httpb...",
           │    "status": 200/503/504,          │
           │    "responseTime": 145,            │
           │    "timeout": false/true,          │
           │    "error": "..." (if any)         │
           │  }                                 │
           │  → console.log (wrangler tail)     │
           └────────────────────────────────────┘
                         │
                         ▼
                ╔═══════════════════════╗
                ║   RESPONSE TO CLIENT  ║
                ║  Status + Body + Hdrs ║
                ╚═══════════════════════╝
```

## Admin Endpoints

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ADMIN ENDPOINTS                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  POST /admin/cache-flush                                              │
│  Header: X-Admin-Key: <admin-key>  (optional if ADMIN_KEY set)        │
│  Response: { "success": true, message: "Cache flushed successfully" } │
│  Effect: Clears in-memory cache → next request refetches from KV      │
│                                                                         │
│  GET /health                                                           │
│  Response: { "status": "ok", "timestamp": "2026-01-31T..." }          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Example Flow with Your Configuration

```
┌──────────────────────────────────────────────────────────────┐
│                  EXAMPLE FLOW WITH YOUR CONFIG               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Client Request:                                            │
│   GET /api/Data/GetVoterInfoListByNameDOBWard?ward=1       │
│                                                              │
│ Route Matching:                                            │
│   1. Check: /api/Data/GetUnionOrPouroList    ✗ No match    │
│   2. Check: /api/Data/GetVoterInfoList...    ✓ MATCH!      │
│                                                              │
│ URL Rewrite:                                               │
│   Strip: /api/Data/GetVoterInfoList...                     │
│   Remaining: (empty)                                        │
│   Target: https://httpbin.org                              │
│   Final URL: https://httpbin.org?ward=1                    │
│                                                              │
│ Proxy Request:                                             │
│   fetch('https://httpbin.org?ward=1', {                    │
│     method: 'GET',                                          │
│     headers: {...original + X-Forwarded-*},                │
│     timeout: 120000                                         │
│   })                                                        │
│                                                              │
│ Response:                                                  │
│   Status: 200 (from httpbin.org)                           │
│   Headers: [Streamed back as-is]                           │
│   Body: [Streamed back as-is]                              │
│                                                              │
│ Logged:                                                    │
│   {                                                         │
│     "timestamp": "2026-01-31T15:00:00.000Z",              │
│     "method": "GET",                                        │
│     "path": "/api/Data/GetVoterInfoListBy...?ward=1",      │
│     "matchedPrefix": "/api/Data/GetVoterInfoListBy...",   │
│     "targetUrl": "https://httpbin.org?ward=1",            │
│     "status": 200,                                          │
│     "responseTime": 234,                                    │
│     "timeout": false                                        │
│   }                                                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Key Components Breakdown

### 1. **Request Reception**
- Cloudflare Worker receives incoming HTTP request
- Extracts path, method, headers, and body
- Routes to appropriate handler (admin or proxy)

### 2. **Configuration Management**
- **KV Namespace**: Centralized config stored in Cloudflare KV
- **In-Memory Cache**: Cached for 12 hours to minimize KV reads
- **TTL Validation**: Checks expiration on every request
- **Fallback**: Returns empty config if KV is unavailable

### 3. **Route Matching**
- **First-Match-Wins**: Routes evaluated in order, first match used
- **Prefix Matching**: Supports `/api/v1`, `/api/v1/users`, etc.
- **Path Extraction**: Remaining path after prefix used for rewrite

### 4. **URL Rewriting**
- **Prefix Stripping**: Removes matched prefix from request path
- **Target Construction**: Appends remaining path to backend target
- **Query Preservation**: All query parameters preserved
- **Base Path Handling**: Respects base paths in target URLs

### 5. **Header Management**
- **Passthrough**: All original headers forwarded as-is
- **X-Forwarded-For**: Client IP appended or created
- **X-Forwarded-Proto**: Original protocol (https/http) added
- **Host Header**: Original host forwarded (can be overridden per route)

### 6. **Request Streaming**
- **No Buffering**: Request body streamed directly
- **Large Payloads**: Supports up to 100MB (free tier) without memory issues
- **Timeout Control**: AbortController with configurable timeout (default 120s)

### 7. **Error Handling**
- **200-299**: Success - stream response directly
- **Timeout (504)**: Backend didn't respond within timeout
- **Error (503)**: Backend unreachable or returned error
- **Other (4xx, 5xx)**: Pass through backend response as-is

### 8. **Response Streaming**
- **Direct Passthrough**: Headers and body streamed back
- **Status Code**: Preserved from backend
- **Headers**: Cloudflare adds security headers, otherwise unchanged

### 9. **Structured Logging**
- **JSON Format**: Machine-readable logs for analysis
- **Timestamp**: ISO 8601 format
- **Metrics**: Response time, status code, timeout flag
- **Context**: Matched prefix, target URL, error messages
- **Integration**: Viewable via `wrangler tail`

### 10. **Admin Controls**
- **Cache Flush**: Force refresh config from KV
- **Health Check**: Verify worker is running
- **Authentication**: Optional admin key for cache flush

## Performance Characteristics

| Component | Latency | Notes |
|-----------|---------|-------|
| KV Read (cached) | < 1µs | In-memory, no network |
| KV Read (miss) | < 60ms | Global replication |
| Route Matching | < 1ms | Linear scan, small route count |
| URL Rewriting | < 1ms | String operations |
| Backend Request | Variable | Depends on backend + timeout |
| Response Streaming | Variable | Direct passthrough |

## Deployment Flow

```
Local Development
    │
    ├─ pnpm install (dependencies)
    ├─ Create KV namespace
    ├─ pnpm run dev (test locally)
    │
    ▼
Staging/Production
    │
    ├─ Create KV namespace
    ├─ Upload config.json to KV
    │   └─ wrangler kv:key put ... "config" --path=config.json
    ├─ Deploy worker
    │   └─ pnpm run deploy
    ├─ Verify with /health
    ├─ Test route matching
    │
    ▼
Running
    │
    ├─ Monitor logs: wrangler tail
    ├─ Update routes: Upload new config to KV
    ├─ Flush cache: curl -X POST /admin/cache-flush
    ├─ Health checks: curl /health
    │
    ▼
Done
```

## Configuration Schema

```json
{
  "routes": [
    {
      "prefix": "/api/v1/users",
      "target": "https://users-service.example.com"
    },
    {
      "prefix": "/api/v1",
      "target": "https://api-service.example.com"
    },
    {
      "prefix": "/",
      "target": "https://default-service.example.com"
    }
  ],
  "version": "1.0"
}
```

**Rules:**
- Routes are checked in order (first match wins)
- Prefix must start with `/`
- Target is the backend URL (no path)
- Query parameters always preserved from request
- Remaining path is appended to target

## Environment Variables

```
REQUEST_TIMEOUT: 120000        # Timeout in milliseconds (default: 120s)
CACHE_TTL: 43200000           # Cache TTL in milliseconds (default: 12h)
ADMIN_KEY: ""                 # Optional key for /admin/cache-flush
```

Set in `wrangler.toml` under `[vars]` section.

## Security Considerations

1. **Admin Endpoint Protection**: Optionally require `ADMIN_KEY` header
2. **Header Filtering**: All headers forwarded; review for sensitive data
3. **Error Details**: Stack traces included in errors; disable in production
4. **KV Access**: Ensure proper permissions configured
5. **Backend URLs**: Only allow trusted upstream services
6. **Rate Limiting**: Consider adding rate limit middleware
7. **Authentication**: Add auth layer for sensitive routes if needed

## Troubleshooting

### 404 on all routes
- Verify KV contains `config` key
- Check config JSON is valid
- Confirm routes array is not empty
- Verify prefix patterns match request paths

### 503 Service Unavailable
- Check backend URL is accessible
- Verify network connectivity
- Review error message in response

### 504 Gateway Timeout
- Increase `REQUEST_TIMEOUT` if needed
- Check backend performance
- Monitor with `wrangler tail`

### Config not updating
- Flush cache: `curl -X POST /admin/cache-flush -H 'X-Admin-Key: ...'`
- Verify KV contains latest config
- Check 12-hour TTL hasn't been extended by old cache

---

**Generated:** 2026-01-31
