import type { AuthAdapter, AuthResult } from '../../types/auth';
import type { Env } from '../../config';

interface ForwardAuthConfig {
  /** URL of the auth service to call */
  url: string;
  /** Request headers to forward to the auth service (default: ["Authorization"]) */
  forwardHeaders?: string[];
  /** Headers from the auth service response to inject into the upstream request */
  upstreamHeaders?: string[];
  [key: string]: unknown;
}

export const forwardAuthAdapter: AuthAdapter = {
  name: 'forward-auth',

  cacheKey(request: Request, config: Record<string, unknown>): string | null {
    const cfg = config as ForwardAuthConfig;
    const headers = cfg.forwardHeaders ?? ['Authorization'];
    // Cache key = concatenation of the forwarded header values
    const parts = headers.map(h => `${h}:${request.headers.get(h) ?? ''}`);
    const key = parts.join('|');
    return key.replace(/^[:|]+$/, '') || null; // null if all headers are empty
  },

  async verify(
    request: Request,
    config: Record<string, unknown>,
    _env: Env,
    _ctx: ExecutionContext
  ): Promise<AuthResult> {
    const cfg = config as ForwardAuthConfig;

    if (!cfg.url) {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'forward-auth: "url" is required in profile config' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    const forwardHeaders = cfg.forwardHeaders ?? ['Authorization'];
    const authHeaders = new Headers();
    for (const header of forwardHeaders) {
      const value = request.headers.get(header);
      if (value) authHeaders.set(header, value);
    }
    // Provide request context to the auth service
    authHeaders.set('X-Forwarded-Uri', request.url);
    authHeaders.set('X-Forwarded-Method', request.method);

    let authResponse: Response;
    try {
      authResponse = await fetch(cfg.url, { method: 'GET', headers: authHeaders });
    } catch {
      return {
        success: false,
        response: new Response(
          JSON.stringify({ error: 'Auth service unreachable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    if (!authResponse.ok) {
      // Pass the auth service response through directly — adapter has full control
      return {
        success: false,
        response: new Response(authResponse.body, {
          status: authResponse.status,
          headers: authResponse.headers,
        }),
      };
    }

    // Extract headers the auth service wants injected into the upstream request
    const upstreamHeaders: Record<string, string> = {};
    for (const header of cfg.upstreamHeaders ?? []) {
      const value = authResponse.headers.get(header);
      if (value) upstreamHeaders[header] = value;
    }

    return { success: true, upstreamHeaders };
  },
};
