// API Key Management (Simplified Implementation)

export interface APIKey {
  id: string;
  key: string;
  name: string;
  tier: 'free' | 'silver' | 'gold' | 'platinum';
  createdAt: string;
  expiresAt?: string;
  owner?: string;
  rateLimit?: {
    requestsPerWindow: number;
    windowSeconds: number;
  };
}

/**
 * Generate a random API key
 */
export function generateAPIKey(): string {
  const prefix = 'sk_live_';
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return prefix + key;
}

/**
 * Validate API key format
 */
export function validateAPIKeyFormat(key: string): boolean {
  return /^sk_live_[a-f0-9]{64}$/.test(key);
}

/**
 * Get tier-based rate limits
 */
export function getTierRateLimit(tier: string): {
  requestsPerWindow: number;
  windowSeconds: number;
} {
  const limits = {
    free: { requestsPerWindow: 100, windowSeconds: 300 },
    silver: { requestsPerWindow: 500, windowSeconds: 300 },
    gold: { requestsPerWindow: 2000, windowSeconds: 300 },
    platinum: { requestsPerWindow: 10000, windowSeconds: 300 }
  };
  
  return limits[tier as keyof typeof limits] || limits.free;
}
