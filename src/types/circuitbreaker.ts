// Circuit Breaker types and interfaces

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation, requests pass through
  OPEN = 'OPEN',         // Circuit is open, requests fail fast
  HALF_OPEN = 'HALF_OPEN' // Testing if backend has recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening circuit (default: 5)
  timeout: number; // Time in ms to wait before attempting recovery (default: 60000)
  halfOpenAttempts: number; // Number of test requests in half-open state (default: 3)
  successThreshold?: number; // Successes needed in half-open to close circuit (default: 2)
  monitoringPeriod?: number; // Time window to count failures (default: 60000)
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  lastStateChange: number;
  nextAttemptTime: number;
  totalRequests: number;
  totalFailures: number;
}

export interface CircuitBreakerStats {
  backend: string;
  state: CircuitState;
  failures: number;
  successes: number;
  uptime: number;
  lastFailure: string | null;
  nextAttempt: string | null;
}
