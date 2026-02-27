// Analytics and Metrics Collection
import { MetricDataPoint, MetricsSnapshot, AggregatedMetric } from './types/metrics';

interface MetricBucket {
  requests: number;
  errors: number;
  latencySum: number;
  latencies: number[];
  statusCodes: Map<number, number>;
  cacheHits: number;
  cacheMisses: number;
  rateLimitBlocked: number;
  rateLimitAllowed: number;
  timestamp: number;
}

// In-memory metrics storage (per worker instance)
class MetricsCollector {
  private oneMinuteBuckets: Map<number, MetricBucket> = new Map();
  private fiveMinuteBuckets: Map<number, MetricBucket> = new Map();
  private oneHourBuckets: Map<number, MetricBucket> = new Map();
  
  private readonly ONE_MINUTE = 60 * 1000;
  private readonly FIVE_MINUTES = 5 * 60 * 1000;
  private readonly ONE_HOUR = 60 * 60 * 1000;
  
  // Retention periods
  private readonly KEEP_ONE_MIN = 60; // Keep 60 one-minute buckets (1 hour)
  private readonly KEEP_FIVE_MIN = 288; // Keep 288 five-minute buckets (24 hours)
  private readonly KEEP_ONE_HOUR = 168; // Keep 168 one-hour buckets (7 days)

  private getBucketTimestamp(now: number, interval: number): number {
    return Math.floor(now / interval) * interval;
  }

  private getOrCreateBucket(buckets: Map<number, MetricBucket>, timestamp: number): MetricBucket {
    let bucket = buckets.get(timestamp);
    if (!bucket) {
      bucket = {
        requests: 0,
        errors: 0,
        latencySum: 0,
        latencies: [],
        statusCodes: new Map(),
        cacheHits: 0,
        cacheMisses: 0,
        rateLimitBlocked: 0,
        rateLimitAllowed: 0,
        timestamp
      };
      buckets.set(timestamp, bucket);
    }
    return bucket;
  }

  private cleanupBuckets(buckets: Map<number, MetricBucket>, maxBuckets: number): void {
    if (buckets.size > maxBuckets) {
      const timestamps = Array.from(buckets.keys()).sort((a, b) => a - b);
      const toDelete = timestamps.slice(0, timestamps.length - maxBuckets);
      toDelete.forEach(ts => buckets.delete(ts));
    }
  }

  recordRequest(statusCode: number, latencyMs: number, isError: boolean): void {
    const now = Date.now();
    
    // Record in all bucket types
    const oneMinTs = this.getBucketTimestamp(now, this.ONE_MINUTE);
    const fiveMinTs = this.getBucketTimestamp(now, this.FIVE_MINUTES);
    const oneHourTs = this.getBucketTimestamp(now, this.ONE_HOUR);
    
    [
      { buckets: this.oneMinuteBuckets, ts: oneMinTs },
      { buckets: this.fiveMinuteBuckets, ts: fiveMinTs },
      { buckets: this.oneHourBuckets, ts: oneHourTs }
    ].forEach(({ buckets, ts }) => {
      const bucket = this.getOrCreateBucket(buckets, ts);
      bucket.requests++;
      if (isError) bucket.errors++;
      bucket.latencySum += latencyMs;
      bucket.latencies.push(latencyMs);
      bucket.statusCodes.set(statusCode, (bucket.statusCodes.get(statusCode) || 0) + 1);
    });
    
    // Cleanup old buckets
    this.cleanupBuckets(this.oneMinuteBuckets, this.KEEP_ONE_MIN);
    this.cleanupBuckets(this.fiveMinuteBuckets, this.KEEP_FIVE_MIN);
    this.cleanupBuckets(this.oneHourBuckets, this.KEEP_ONE_HOUR);
  }

  recordCache(isHit: boolean): void {
    const now = Date.now();
    const oneMinTs = this.getBucketTimestamp(now, this.ONE_MINUTE);
    const fiveMinTs = this.getBucketTimestamp(now, this.FIVE_MINUTES);
    const oneHourTs = this.getBucketTimestamp(now, this.ONE_HOUR);
    
    [
      { buckets: this.oneMinuteBuckets, ts: oneMinTs },
      { buckets: this.fiveMinuteBuckets, ts: fiveMinTs },
      { buckets: this.oneHourBuckets, ts: oneHourTs }
    ].forEach(({ buckets, ts }) => {
      const bucket = this.getOrCreateBucket(buckets, ts);
      if (isHit) {
        bucket.cacheHits++;
      } else {
        bucket.cacheMisses++;
      }
    });
  }

  recordRateLimit(blocked: boolean): void {
    const now = Date.now();
    const oneMinTs = this.getBucketTimestamp(now, this.ONE_MINUTE);
    const fiveMinTs = this.getBucketTimestamp(now, this.FIVE_MINUTES);
    const oneHourTs = this.getBucketTimestamp(now, this.ONE_HOUR);
    
    [
      { buckets: this.oneMinuteBuckets, ts: oneMinTs },
      { buckets: this.fiveMinuteBuckets, ts: fiveMinTs },
      { buckets: this.oneHourBuckets, ts: oneHourTs }
    ].forEach(({ buckets, ts }) => {
      const bucket = this.getOrCreateBucket(buckets, ts);
      if (blocked) {
        bucket.rateLimitBlocked++;
      } else {
        bucket.rateLimitAllowed++;
      }
    });
  }

  private calculatePercentile(sortedLatencies: number[], percentile: number): number {
    if (sortedLatencies.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedLatencies.length) - 1;
    return sortedLatencies[Math.max(0, index)];
  }

  private aggregateBuckets(buckets: Map<number, MetricBucket>): MetricsSnapshot {
    const allBuckets = Array.from(buckets.values());
    if (allBuckets.length === 0) {
      return this.emptySnapshot();
    }

    let totalRequests = 0;
    let totalErrors = 0;
    let allLatencies: number[] = [];
    const statusCounts: Record<number, number> = {};
    let cacheHits = 0;
    let cacheMisses = 0;
    let rateLimitBlocked = 0;
    let rateLimitAllowed = 0;

    allBuckets.forEach(bucket => {
      totalRequests += bucket.requests;
      totalErrors += bucket.errors;
      allLatencies = allLatencies.concat(bucket.latencies);
      bucket.statusCodes.forEach((count, status) => {
        statusCounts[status] = (statusCounts[status] || 0) + count;
      });
      cacheHits += bucket.cacheHits;
      cacheMisses += bucket.cacheMisses;
      rateLimitBlocked += bucket.rateLimitBlocked;
      rateLimitAllowed += bucket.rateLimitAllowed;
    });

    allLatencies.sort((a, b) => a - b);
    const avgLatency = allLatencies.length > 0 
      ? allLatencies.reduce((sum, l) => sum + l, 0) / allLatencies.length 
      : 0;

    return {
      requests: {
        total: totalRequests,
        success: totalRequests - totalErrors,
        errors: totalErrors,
        byStatus: statusCounts
      },
      latency: {
        p50: this.calculatePercentile(allLatencies, 50),
        p95: this.calculatePercentile(allLatencies, 95),
        p99: this.calculatePercentile(allLatencies, 99),
        avg: avgLatency
      },
      cache: {
        hits: cacheHits,
        misses: cacheMisses,
        hitRate: (cacheHits + cacheMisses) > 0 
          ? (cacheHits / (cacheHits + cacheMisses)) * 100 
          : 0
      },
      rateLimit: {
        blocked: rateLimitBlocked,
        allowed: rateLimitAllowed
      },
      timestamp: Date.now(),
      window: 'aggregated'
    };
  }

  private emptySnapshot(): MetricsSnapshot {
    return {
      requests: { total: 0, success: 0, errors: 0, byStatus: {} },
      latency: { p50: 0, p95: 0, p99: 0, avg: 0 },
      cache: { hits: 0, misses: 0, hitRate: 0 },
      rateLimit: { blocked: 0, allowed: 0 },
      timestamp: Date.now(),
      window: 'empty'
    };
  }

  getMetrics(window: '1m' | '5m' | '1h' | 'all'): MetricsSnapshot {
    let buckets: Map<number, MetricBucket>;
    
    switch (window) {
      case '1m':
        buckets = this.oneMinuteBuckets;
        break;
      case '5m':
        buckets = this.fiveMinuteBuckets;
        break;
      case '1h':
        buckets = this.oneHourBuckets;
        break;
      case 'all':
      default:
        // Aggregate all buckets
        const allBuckets = new Map<number, MetricBucket>();
        this.oneHourBuckets.forEach((v, k) => allBuckets.set(k, v));
        buckets = allBuckets;
        break;
    }
    
    const snapshot = this.aggregateBuckets(buckets);
    snapshot.window = window;
    return snapshot;
  }

  reset(): void {
    this.oneMinuteBuckets.clear();
    this.fiveMinuteBuckets.clear();
    this.oneHourBuckets.clear();
  }
}

// Singleton instance
export const metrics = new MetricsCollector();
