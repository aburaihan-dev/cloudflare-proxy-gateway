// Circuit Breaker Pattern Implementation
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerStats
} from './types/circuitbreaker';

const DEFAULT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  timeout: 60000,
  halfOpenAttempts: 3,
  successThreshold: 2,
  monitoringPeriod: 60000
};

export class CircuitBreaker {
  private states: Map<string, CircuitBreakerState> = new Map();
  private failureHistory: Map<string, number[]> = new Map();

  /**
   * Get or create circuit breaker state for a backend
   */
  private getState(backend: string): CircuitBreakerState {
    let state = this.states.get(backend);
    
    if (!state) {
      state = {
        state: CircuitState.CLOSED,
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        lastStateChange: Date.now(),
        nextAttemptTime: 0,
        totalRequests: 0,
        totalFailures: 0
      };
      this.states.set(backend, state);
    }
    
    return state;
  }

  /**
   * Get failure history for a backend
   */
  private getFailureHistory(backend: string): number[] {
    let history = this.failureHistory.get(backend);
    
    if (!history) {
      history = [];
      this.failureHistory.set(backend, history);
    }
    
    return history;
  }

  /**
   * Clean up old failures from history
   */
  private cleanupHistory(backend: string, monitoringPeriod: number): void {
    const history = this.getFailureHistory(backend);
    const cutoff = Date.now() - monitoringPeriod;
    
    // Remove failures older than monitoring period
    const recentFailures = history.filter(timestamp => timestamp > cutoff);
    this.failureHistory.set(backend, recentFailures);
  }

  /**
   * Check if request should be allowed through circuit breaker
   */
  canRequest(backend: string, config: CircuitBreakerConfig): {
    allowed: boolean;
    reason?: string;
  } {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const state = this.getState(backend);
    const now = Date.now();

    // Clean up old failures
    this.cleanupHistory(backend, fullConfig.monitoringPeriod);

    switch (state.state) {
      case CircuitState.CLOSED:
        // Normal operation
        return { allowed: true };

      case CircuitState.OPEN:
        // Check if timeout has elapsed
        if (now >= state.nextAttemptTime) {
          // Transition to half-open
          this.transitionTo(backend, CircuitState.HALF_OPEN);
          return { allowed: true };
        }
        
        return {
          allowed: false,
          reason: `Circuit breaker OPEN for ${backend}. Next attempt at ${new Date(state.nextAttemptTime).toISOString()}`
        };

      case CircuitState.HALF_OPEN:
        // Allow limited test requests
        if (state.totalRequests < fullConfig.halfOpenAttempts) {
          return { allowed: true };
        }
        
        return {
          allowed: false,
          reason: `Circuit breaker HALF_OPEN for ${backend}. Testing in progress.`
        };

      default:
        return { allowed: true };
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(backend: string, config: CircuitBreakerConfig): void {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const state = this.getState(backend);
    
    state.successes++;
    state.totalRequests++;

    if (state.state === CircuitState.HALF_OPEN) {
      // Check if we have enough successes to close the circuit
      if (state.successes >= fullConfig.successThreshold) {
        this.transitionTo(backend, CircuitState.CLOSED);
        state.failures = 0;
        state.successes = 0;
        
        // Clear failure history
        this.failureHistory.set(backend, []);
      }
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(backend: string, config: CircuitBreakerConfig): void {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    const state = this.getState(backend);
    const now = Date.now();
    
    state.failures++;
    state.totalRequests++;
    state.totalFailures++;
    state.lastFailureTime = now;

    // Add to failure history
    const history = this.getFailureHistory(backend);
    history.push(now);
    
    // Clean up old failures
    this.cleanupHistory(backend, fullConfig.monitoringPeriod);

    switch (state.state) {
      case CircuitState.CLOSED:
        // Check if we've exceeded failure threshold
        const recentFailures = this.getFailureHistory(backend).length;
        if (recentFailures >= fullConfig.failureThreshold) {
          this.transitionTo(backend, CircuitState.OPEN, fullConfig.timeout);
        }
        break;

      case CircuitState.HALF_OPEN:
        // Any failure in half-open state reopens the circuit
        this.transitionTo(backend, CircuitState.OPEN, fullConfig.timeout);
        state.successes = 0;
        break;

      case CircuitState.OPEN:
        // Already open, just record the failure
        break;
    }
  }

  /**
   * Transition circuit breaker to a new state
   */
  private transitionTo(
    backend: string,
    newState: CircuitState,
    timeout?: number
  ): void {
    const state = this.getState(backend);
    const now = Date.now();
    
    console.log(`Circuit breaker for ${backend}: ${state.state} → ${newState}`);
    
    state.state = newState;
    state.lastStateChange = now;
    state.totalRequests = 0;

    if (newState === CircuitState.OPEN && timeout) {
      state.nextAttemptTime = now + timeout;
    } else if (newState === CircuitState.CLOSED) {
      state.nextAttemptTime = 0;
      state.failures = 0;
      state.successes = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      state.successes = 0;
    }
  }

  /**
   * Manually reset circuit breaker for a backend
   */
  reset(backend: string): void {
    const state = this.getState(backend);
    this.transitionTo(backend, CircuitState.CLOSED);
    state.failures = 0;
    state.successes = 0;
    state.totalFailures = 0;
    this.failureHistory.set(backend, []);
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(backend?: string): CircuitBreakerStats[] {
    const stats: CircuitBreakerStats[] = [];
    const now = Date.now();

    if (backend) {
      const state = this.states.get(backend);
      if (state) {
        stats.push(this.formatStats(backend, state, now));
      }
    } else {
      this.states.forEach((state, backendUrl) => {
        stats.push(this.formatStats(backendUrl, state, now));
      });
    }

    return stats;
  }

  private formatStats(
    backend: string,
    state: CircuitBreakerState,
    now: number
  ): CircuitBreakerStats {
    return {
      backend,
      state: state.state,
      failures: state.totalFailures,
      successes: state.successes,
      uptime: now - state.lastStateChange,
      lastFailure: state.lastFailureTime > 0
        ? new Date(state.lastFailureTime).toISOString()
        : null,
      nextAttempt: state.nextAttemptTime > 0
        ? new Date(state.nextAttemptTime).toISOString()
        : null
    };
  }

  /**
   * Get all backends with open circuits
   */
  getOpenCircuits(): string[] {
    const open: string[] = [];
    
    this.states.forEach((state, backend) => {
      if (state.state === CircuitState.OPEN) {
        open.push(backend);
      }
    });
    
    return open;
  }
}

// Singleton instance
export const circuitBreaker = new CircuitBreaker();
