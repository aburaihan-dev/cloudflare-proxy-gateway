// Geo-Routing Implementation

export interface GeoRoutingConfig {
  enabled: boolean;
  targets: Record<string, string>; // Country/region code -> target URL
  continentMapping?: Record<string, string[]>; // Continent -> country codes
  defaultTarget?: string; // Fallback target
}

// Continent to country code mapping
const DEFAULT_CONTINENT_MAPPING: Record<string, string[]> = {
  'EU': ['DE', 'FR', 'IT', 'ES', 'GB', 'NL', 'BE', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'AT', 'CH'],
  'ASIA': ['CN', 'JP', 'KR', 'IN', 'SG', 'TH', 'MY', 'ID', 'PH', 'VN'],
  'NA': ['US', 'CA', 'MX'],
  'SA': ['BR', 'AR', 'CL', 'CO', 'PE'],
  'OCEANIA': ['AU', 'NZ'],
  'AFRICA': ['ZA', 'EG', 'NG', 'KE']
};

/**
 * Get target URL based on geo location
 */
export function getGeoTarget(
  request: Request,
  config: GeoRoutingConfig
): string | null {
  if (!config.enabled) {
    return null;
  }

  // Get country code from Cloudflare request
  const country = request.headers.get('cf-ipcountry') || (request as any).cf?.country;
  
  if (!country) {
    return config.defaultTarget || null;
  }

  // Check direct country mapping
  if (config.targets[country]) {
    return config.targets[country];
  }

  // Check continent mapping
  const continentMapping = config.continentMapping || DEFAULT_CONTINENT_MAPPING;
  
  for (const [continent, countries] of Object.entries(continentMapping)) {
    if (countries.includes(country) && config.targets[continent]) {
      return config.targets[continent];
    }
  }

  // Return default target
  return config.defaultTarget || null;
}
