// Load Balancer types and interfaces

export interface Backend {
  url: string;
  weight: number; // Weight for weighted random (default: 100)
  enabled?: boolean; // If false, backend is disabled (default: true)
}

export interface LoadBalancingConfig {
  strategy: 'weighted-random' | 'round-robin';
  stickySession?: boolean; // Enable sticky sessions (default: false)
}

export interface LoadBalancerStats {
  backend: string;
  requests: number;
  failures: number;
  lastUsed: string | null;
}
