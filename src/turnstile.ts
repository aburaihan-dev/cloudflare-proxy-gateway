import { ProxyConfig } from './config';

interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Verifies the Turnstile token with Cloudflare's API.
 * Returns true if valid, false otherwise.
 */
export async function verifyTurnstileToken(
  token: string, 
  secretKey: string, 
  ip?: string
): Promise<boolean> {
  if (!token) return false;

  const formData = new FormData();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (ip) {
    formData.append('remoteip', ip);
  }

  try {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      body: formData,
      method: 'POST',
    });

    const outcome = await result.json() as TurnstileVerifyResponse;
    return outcome.success;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    // Fail closed (deny) on error for security, or open? 
    // Usually fail closed for security.
    return false;
  }
}
