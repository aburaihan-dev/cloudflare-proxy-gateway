import type { Env } from '../config';
import type { AuthResult, AuthCacheConfig } from '../types/auth';

function getKvNamespace(env: Env, config: AuthCacheConfig): KVNamespace | null {
  const binding = config.kvBinding ?? 'PROXY_AUTH_CACHE';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kv = (env as any)[binding];
  return kv ?? null;
}

function buildKey(adapterName: string, cacheKey: string, kvBinding?: string): string {
  // When sharing PROXY_CACHE, prefix keys to avoid collisions
  const prefix = kvBinding === 'PROXY_CACHE' ? 'auth:' : '';
  return `${prefix}${adapterName}:${cacheKey}`;
}

type CacheableAuthResult = Pick<AuthResult, 'success' | 'upstreamHeaders'>;

export async function getCachedAuthResult(
  adapterName: string,
  cacheKey: string,
  config: AuthCacheConfig,
  env: Env
): Promise<AuthResult | null> {
  if (!config.enabled) return null;
  const kv = getKvNamespace(env, config);
  if (!kv) return null;

  const key = buildKey(adapterName, cacheKey, config.kvBinding);
  return kv.get<CacheableAuthResult>(key, 'json') as Promise<AuthResult | null>;
}

export async function setCachedAuthResult(
  adapterName: string,
  cacheKey: string,
  result: AuthResult,
  config: AuthCacheConfig,
  env: Env
): Promise<void> {
  if (!config.enabled || !result.success) return;
  const kv = getKvNamespace(env, config);
  if (!kv) return;

  const key = buildKey(adapterName, cacheKey, config.kvBinding);
  // Strip the Response object — not serializable, only needed on failures
  const cacheable: CacheableAuthResult = {
    success: result.success,
    upstreamHeaders: result.upstreamHeaders,
  };
  await kv.put(key, JSON.stringify(cacheable), { expirationTtl: config.ttl });
}
