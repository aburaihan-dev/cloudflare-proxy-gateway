import type { Env } from '../config';
import type { AuthFeatureConfig, AuthResult } from '../types/auth';
import { getAdapter, listAdapters } from './registry';
import { getCachedAuthResult, setCachedAuthResult } from './cache';

const DEFAULT_401: AuthResult = {
  success: false,
  response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  }),
};

/**
 * Auth orchestrator — called from the request pipeline.
 * Resolves the adapter, checks cache, runs verify(), stores result in cache.
 */
export async function runAuth(
  request: Request,
  profileConfig: Record<string, unknown>,
  featureConfig: AuthFeatureConfig,
  env: Env,
  ctx: ExecutionContext
): Promise<AuthResult> {
  const adapterName = profileConfig.adapter as string;
  const adapter = getAdapter(adapterName);

  if (!adapter) {
    console.error(`[auth] Adapter "${adapterName}" is not registered. Registered: ${listAdapters().join(', ') || '(none)'}`);
    return {
      success: false,
      response: new Response(
        JSON.stringify({ error: `Auth adapter "${adapterName}" is not registered` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const cacheConfig = featureConfig.cache;

  // Cache read
  if (cacheConfig?.enabled) {
    const key = adapter.cacheKey(request, profileConfig);
    if (key !== null) {
      const cached = await getCachedAuthResult(adapter.name, key, cacheConfig, env);
      if (cached) return cached;
    }
  }

  // Verify
  let result: AuthResult;
  try {
    result = await adapter.verify(request, profileConfig, env, ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[auth] Adapter "${adapterName}" threw: ${message}`);
    return DEFAULT_401;
  }

  // Cache write (non-blocking, only on success)
  if (result.success && cacheConfig?.enabled) {
    const key = adapter.cacheKey(request, profileConfig);
    if (key !== null) {
      ctx.waitUntil(setCachedAuthResult(adapter.name, key, result, cacheConfig, env));
    }
  }

  return result;
}
