// IP Control (Allowlist/Blocklist) with CIDR support

interface IPControlConfig {
  mode: 'allowlist' | 'blocklist';
  ips: string[]; // IP addresses or CIDR ranges
  blockMessage?: string;
}

/**
 * Check if IP matches a CIDR range
 */
function ipMatchesCIDR(ip: string, cidr: string): boolean {
  // Simple implementation - in production use a proper CIDR library
  if (!cidr.includes('/')) {
    // Exact match
    return ip === cidr;
  }
  
  const [range, bits] = cidr.split('/');
  const mask = -1 << (32 - parseInt(bits));
  
  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  
  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Convert IP address to number
 */
function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * Check if IP is allowed based on control config
 */
export function checkIPControl(
  clientIP: string,
  config?: IPControlConfig
): { allowed: boolean; reason?: string } {
  if (!config || !config.ips || config.ips.length === 0) {
    return { allowed: true };
  }

  const matches = config.ips.some(ipOrCidr => ipMatchesCIDR(clientIP, ipOrCidr));

  if (config.mode === 'allowlist') {
    if (matches) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: config.blockMessage || 'IP not in allowlist'
    };
  } else {
    // blocklist mode
    if (matches) {
      return {
        allowed: false,
        reason: config.blockMessage || 'IP blocked'
      };
    }
    return { allowed: true };
  }
}
