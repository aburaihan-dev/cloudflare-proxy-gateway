import type { AuthAdapter, AuthResult } from '../../types/auth';
import type { Env } from '../../config';

type TokenExtractionType = 'header' | 'custom-header' | 'cookie' | 'query';

interface TokenExtraction {
  type: TokenExtractionType;
  /** Header name, cookie name, or query param name */
  name?: string;
  /** Scheme prefix to strip — only applies to type "header" (default: "Bearer") */
  scheme?: string;
}

interface JwtConfig {
  /** JWKS URL for RS256/ES256 validation */
  jwksUrl?: string;
  /** Shared secret for HS256 validation */
  secret?: string;
  /** Expected audience claim */
  audience?: string;
  /** Expected issuer claim */
  issuer?: string;
  /** Token extraction strategy (default: Authorization: Bearer) */
  tokenExtraction?: TokenExtraction;
  [key: string]: unknown;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtPayload {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
  [key: string]: unknown;
}

// In-memory JWKS cache (per-isolate), avoids fetching on every request
const jwksCache = new Map<string, { keys: JsonWebKey[]; cachedAt: number }>();
const JWKS_CACHE_TTL_MS = 3_600_000; // 1 hour

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function extractToken(request: Request, extraction?: TokenExtraction): string | null {
  const strategy: TokenExtraction = extraction ?? { type: 'header', name: 'Authorization', scheme: 'Bearer' };

  switch (strategy.type) {
    case 'header': {
      const headerName = strategy.name ?? 'Authorization';
      const scheme = strategy.scheme ?? 'Bearer';
      const value = request.headers.get(headerName);
      if (!value) return null;
      return value.startsWith(`${scheme} `) ? value.slice(scheme.length + 1).trim() : value.trim();
    }
    case 'custom-header':
      return request.headers.get(strategy.name ?? 'X-Auth-Token');
    case 'cookie': {
      const cookieHeader = request.headers.get('Cookie') ?? '';
      const name = strategy.name ?? 'token';
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      return match ? match[1] : null;
    }
    case 'query':
      return new URL(request.url).searchParams.get(strategy.name ?? 'token');
    default:
      return null;
  }
}

async function verifyHs256(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JwtPayload;
}

async function fetchJwks(jwksUrl: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() - cached.cachedAt < JWKS_CACHE_TTL_MS) return cached.keys;

  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json() as { keys: JsonWebKey[] };
  jwksCache.set(jwksUrl, { keys, cachedAt: Date.now() });
  return keys;
}

async function verifyJwks(token: string, jwksUrl: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as JwtHeader;
  const keys = await fetchJwks(jwksUrl);
  const jwk = keys.find(k => !header.kid || (k as unknown as Record<string, unknown>)['kid'] === header.kid);
  if (!jwk) return null;

  const isEc = header.alg === 'ES256';
  const algorithm = isEc
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

  const cryptoKey = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);

  const verifyAlg = isEc ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5';
  const valid = await crypto.subtle.verify(
    verifyAlg,
    cryptoKey,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JwtPayload;
}

function validateClaims(payload: JwtPayload, cfg: JwtConfig): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && payload.exp < now) return 'Token expired';
  if (payload.nbf !== undefined && payload.nbf > now) return 'Token not yet valid';
  if (cfg.issuer && payload.iss !== cfg.issuer) return 'Invalid issuer';
  if (cfg.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.audience)) return 'Invalid audience';
  }
  return null;
}

function jwtUnauthorized(message: string, hint?: string): AuthResult {
  return {
    success: false,
    response: new Response(
      JSON.stringify({ error: message, ...(hint ? { hint } : {}) }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer error="invalid_token"',
        },
      }
    ),
  };
}

export const jwtAdapter: AuthAdapter = {
  name: 'jwt',

  cacheKey(request: Request, config: Record<string, unknown>): string | null {
    const cfg = config as JwtConfig;
    return extractToken(request, cfg.tokenExtraction);
  },

  async verify(
    request: Request,
    config: Record<string, unknown>,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<AuthResult> {
    const cfg = config as JwtConfig;
    const token = extractToken(request, cfg.tokenExtraction);

    if (!token) {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'Missing authentication token' }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer',
            },
          }
        ),
      };
    }

    if (!cfg.secret && !cfg.jwksUrl) {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'jwt adapter: "secret" or "jwksUrl" is required' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    let payload: JwtPayload | null = null;
    try {
      payload = cfg.secret
        ? await verifyHs256(token, cfg.secret)
        : await verifyJwks(token, cfg.jwksUrl!);
    } catch {
      return jwtUnauthorized('Token verification failed');
    }

    if (!payload) return jwtUnauthorized('Invalid token signature');

    const claimError = validateClaims(payload, cfg);
    if (claimError) return jwtUnauthorized(claimError);

    const upstreamHeaders: Record<string, string> = {};
    if (payload.sub) upstreamHeaders['X-User-Id'] = payload.sub;
    if (typeof payload.email === 'string') upstreamHeaders['X-User-Email'] = payload.email;

    return { success: true, upstreamHeaders };
  },
};
