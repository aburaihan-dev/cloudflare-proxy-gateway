// Metrics types and interfaces

export interface MetricDataPoint {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

export interface AggregatedMetric {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

export interface MetricsSnapshot {
  requests: {
    total: number;
    success: number;
    errors: number;
    byStatus: Record<number, number>;
  };
  latency: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
  };
  cache?: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  rateLimit?: {
    blocked: number;
    allowed: number;
  };
  timestamp: number;
  window: string; // e.g., '1m', '5m', '1h'
}

export interface MetricsConfig {
  enabled: boolean;
  retention: {
    oneMinute: number; // Keep 1-minute buckets for X minutes
    fiveMinute: number; // Keep 5-minute buckets for X hours
    oneHour: number; // Keep 1-hour buckets for X days
  };
}
