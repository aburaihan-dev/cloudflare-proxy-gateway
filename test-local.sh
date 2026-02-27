#!/bin/bash
# Local testing script for proxy load balancer

echo "🧪 Testing Proxy Load Balancer Locally"
echo "========================================"
echo ""

BASE_URL="http://localhost:8787"

# Test 1: Health check
echo "✅ Test 1: Health Check"
curl -s "$BASE_URL/health" | jq .
echo ""
echo ""

# Test 2: Route matching with /api/v1/users prefix
echo "✅ Test 2: Route Matching - /api/v1/users/posts/1"
echo "Expected: Routes to jsonplaceholder.typicode.com"
curl -s "$BASE_URL/api/v1/users/posts/1" | jq .
echo ""
echo ""

# Test 3: Query string preservation
echo "✅ Test 3: Query String Preservation - /api/v1/get?foo=bar&test=123"
echo "Expected: Query params preserved in proxied request"
curl -s "$BASE_URL/api/v1/get?foo=bar&test=123" | jq '{args, url}'
echo ""
echo ""

# Test 4: Different route matching - /api/v1
echo "✅ Test 4: Different Route - /api/v1/status"
curl -s "$BASE_URL/api/v1/status" | jq .
echo ""
echo ""

# Test 5: POST request with body
echo "✅ Test 5: POST Request with Body - /api/v1/post"
curl -s -X POST "$BASE_URL/api/v1/post" \
  -H "Content-Type: application/json" \
  -d '{"name":"test","value":"123"}' | jq '{data, json, url}'
echo ""
echo ""

# Test 6: Header forwarding
echo "✅ Test 6: Custom Headers - /api/v1/headers"
curl -s "$BASE_URL/api/v1/headers" \
  -H "X-Custom-Header: test-value" \
  -H "Authorization: Bearer token123" | jq '.headers | {Authorization, "X-Custom-Header"}'
echo ""
echo ""

# Test 7: Cache flush endpoint
echo "✅ Test 7: Cache Flush Endpoint"
curl -s -X POST "$BASE_URL/admin/cache-flush" | jq .
echo ""
echo ""

# Test 8: 404 for unmatched route
echo "✅ Test 8: Unmatched Route (404)"
curl -s "$BASE_URL/unmatched/path"
echo ""
echo ""

# Test 9: Verify logs show structured data
echo "✅ Test 9: Check wrangler logs for structured JSON"
echo "Run: pnpm run dev (in another terminal) to see logs"
echo ""

echo "========================================"
echo "✨ Testing Complete!"
echo ""
echo "To see detailed logs, check the wrangler dev terminal output"
