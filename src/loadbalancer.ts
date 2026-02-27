// Load Balancing Implementation
import { Backend, LoadBalancingConfig, LoadBalancerStats } from './types/loadbalancer';
import { circuitBreaker } from './circuitbreaker';
import { CircuitState, CircuitBreakerConfig } from './types/circuitbreaker';

interface BackendStats {
  requests: number;
  failures: number;
  lastUsed: number;
}

class LoadBalancer {
  private stats: Map<string, BackendStats> = new Map();
  private roundRobinIndex: Map<string, number> = new Map();

  /**
   * Select a backend using weighted random strategy
   */
  selectWeightedRandom(
    backends: Backend[],
    routeKey: string,
    circuitBreakerConfig?: CircuitBreakerConfig
  ): Backend | null {
    // Filter out disabled backends and those with open circuits
    const availableBackends = backends.filter(b => {
      if (b.enabled === false) return false;
      
      if (circuitBreakerConfig) {
        const cbStats = circuitBreaker.getStats(b.url);
        if (cbStats.length > 0 && cbStats[0].state === CircuitState.OPEN) {
          return false;
        }
      }
      
      return true;
    });

    if (availableBackends.length === 0) {
      return null;
    }

    // Calculate total weight
    const totalWeight = availableBackends.reduce((sum, b) => sum + b.weight, 0);
    
    // Generate random number
    let random = Math.random() * totalWeight;
    
    // Select backend based on weight
    for (const backend of availableBackends) {
      random -= backend.weight;
      if (random <= 0) {
        this.recordBackendSelection(backend.url);
        return backend;
      }
    }
    
    // Fallback to first backend
    this.recordBackendSelection(availableBackends[0].url);
    return availableBackends[0];
  }

  /**
   * Select a backend using round-robin strategy
   */
  selectRoundRobin(
    backends: Backend[],
    routeKey: string,
    circuitBreakerConfig?: CircuitBreakerConfig
  ): Backend | null {
    // Filter out disabled backends and those with open circuits
    const availableBackends = backends.filter(b => {
      if (b.enabled === false) return false;
      
      if (circuitBreakerConfig) {
        const cbStats = circuitBreaker.getStats(b.url);
        if (cbStats.length > 0 && cbStats[0].state === CircuitState.OPEN) {
          return false;
        }
      }
      
      return true;
    });

    if (availableBackends.length === 0) {
      return null;
    }

    // Get current index for this route
    let index = this.roundRobinIndex.get(routeKey) || 0;
    
    // Select backend
    const backend = availableBackends[index % availableBackends.length];
    
    // Update index for next request
    this.roundRobinIndex.set(routeKey, (index + 1) % availableBackends.length);
    
    this.recordBackendSelection(backend.url);
    return backend;
  }

  /**
   * Record backend selection
   */
  private recordBackendSelection(backendUrl: string): void {
    let stats = this.stats.get(backendUrl);
    
    if (!stats) {
      stats = { requests: 0, failures: 0, lastUsed: Date.now() };
      this.stats.set(backendUrl, stats);
    }
    
    stats.requests++;
    stats.lastUsed = Date.now();
  }

  /**
   * Record backend failure
   */
  recordFailure(backendUrl: string): void {
    const stats = this.stats.get(backendUrl);
    if (stats) {
      stats.failures++;
    }
  }

  /**
   * Get load balancer statistics
   */
  getStats(): LoadBalancerStats[] {
    const result: LoadBalancerStats[] = [];
    
    this.stats.forEach((stats, backend) => {
      result.push({
        backend,
        requests: stats.requests,
        failures: stats.failures,
        lastUsed: new Date(stats.lastUsed).toISOString()
      });
    });
    
    return result;
  }
}

export const loadBalancer = new LoadBalancer();
