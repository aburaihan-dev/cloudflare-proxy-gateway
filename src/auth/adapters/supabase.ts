/**
 * Example Custom Adapter: Supabase Auth
 *
 * Demonstrates how to write a custom auth adapter that integrates
 * with a third-party service (Supabase) without touching any core proxy code.
 *
 * Supports two verification strategies — configurable per profile:
 *   1. Local JWT (default) — validates using your Supabase JWT secret (fast, no external call)
 *   2. API verification   — calls Supabase /auth/v1/user (always fresh, one extra round-trip)
 *
 * Upstream headers forwarded to the backend on success:
 *   X-User-Id     — Supabase user UUID (JWT "sub" claim)
 *   X-User-Email  — user email
 *   X-User-Role   — "authenticated" or "anon"
 *
 * Config example:
 * {
 *   "adapter": "supabase",
 *   "supabaseUrl": "https://xxxx.supabase.co",
 *   "supabaseJwtSecret": "your-jwt-secret",  // Project Settings → API → JWT Secret
 *   "verifyViaApi": false                     // true = call /auth/v1/user instead
 * }
 */
import type { AuthAdapter, AuthResult } from '../../types/auth';
import type { Env } from '../../config';

interface SupabaseConfig {
  supabaseUrl?: string;
  supabaseJwtSecret?: string;
  /** When true, verifies by calling Supabase /auth/v1/user instead of local JWT */
  verifyViaApi?: boolean;
  [key: string]: unknown;
}

interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  aud?: string | string[];
  [key: string]: unknown;
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

function supabaseError(message: string, hint?: string, status = 401): AuthResult {
  return {
    success: false,
    response: new Response(
      JSON.stringify({ message, ...(hint ? { hint } : {}) }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="supabase"',
        },
      }
    ),
  };
}

async function verifySupabaseJwt(
  token: string,
  secret: string
): Promise<SupabaseJwtPayload | null> {
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

  return JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64))
  ) as SupabaseJwtPayload;
}

async function verifyViaSupabaseApi(
  token: string,
  supabaseUrl: string
): Promise<{ id: string; email: string; role: string } | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: token,
    },
  });
  if (!response.ok) return null;
  return response.json() as Promise<{ id: string; email: string; role: string }>;
}

export const supabaseAdapter: AuthAdapter = {
  name: 'supabase',

  cacheKey(request: Request, _config: Record<string, unknown>): string | null {
    // The signed JWT token is the cache key — it already encodes identity + expiry
    return extractBearerToken(request);
  },

  async verify(
    request: Request,
    config: Record<string, unknown>,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<AuthResult> {
    const cfg = config as SupabaseConfig;
    const token = extractBearerToken(request);

    if (!token) {
      return supabaseError(
        'Missing authentication token',
        'Include an Authorization: Bearer <token> header'
      );
    }

    // --- Strategy: API verification ---
    if (cfg.verifyViaApi) {
      if (!cfg.supabaseUrl) {
        return supabaseError('supabase adapter: "supabaseUrl" is required', undefined, 500);
      }
      let user: { id: string; email: string; role: string } | null;
      try {
        user = await verifyViaSupabaseApi(token, cfg.supabaseUrl);
      } catch {
        return supabaseError('Auth service unavailable', 'Try again later', 503);
      }
      if (!user) {
        return supabaseError('Invalid or expired token', 'Re-authenticate to get a fresh token');
      }
      return {
        success: true,
        upstreamHeaders: {
          'X-User-Id': user.id,
          'X-User-Email': user.email,
          'X-User-Role': user.role ?? 'authenticated',
        },
      };
    }

    // --- Strategy: Local JWT verification (default) ---
    if (!cfg.supabaseJwtSecret) {
      return supabaseError('supabase adapter: "supabaseJwtSecret" is required', undefined, 500);
    }

    let payload: SupabaseJwtPayload | null;
    try {
      payload = await verifySupabaseJwt(token, cfg.supabaseJwtSecret);
    } catch {
      return supabaseError('Token verification failed');
    }

    if (!payload) {
      return supabaseError('Invalid token', 'Token signature is invalid');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp < now) {
      return supabaseError('Token expired', 'Re-authenticate to get a fresh token');
    }

    // Reject anonymous tokens — callers should use authenticated sessions
    if (payload.role === 'anon') {
      return supabaseError(
        'Authentication required',
        'Anonymous tokens are not accepted for this route'
      );
    }

    return {
      success: true,
      upstreamHeaders: {
        ...(payload.sub && { 'X-User-Id': payload.sub }),
        ...(payload.email && { 'X-User-Email': payload.email }),
        ...(payload.role && { 'X-User-Role': payload.role }),
      },
    };
  },
};
