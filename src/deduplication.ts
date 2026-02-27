// Request Deduplication
import { metrics } from './metrics';

interface PendingRequest {
  promise: Promise<Response>;
  timestamp: number;
}

interface DeduplicationConfig {
  enabled: boolean;
  windowMs?: number; // Deduplication window in milliseconds (default: 5000)
}

export class RequestDeduplicator {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private readonly defaultWindowMs = 5000; // 5 seconds
  
  /**
   * Generate a hash key for request deduplication
   */
  generateRequestHash(request: Request): string {
    const url = new URL(request.url);
    const parts = [
      request.method,
      url.pathname,
      url.search
    ];
    
    // Include certain headers that affect response
    const relevantHeaders = [
      'accept',
      'accept-language',
      'content-type',
      'authorization'
    ];
    
    relevantHeaders.forEach(header => {
      const value = request.headers.get(header);
      if (value) {
        parts.push(`${header}:${value}`);
      }
    });
    
    return parts.join('::');
  }

  /**
   * Check if a request is currently pending
   */
  hasPending(requestHash: string): boolean {
    const pending = this.pendingRequests.get(requestHash);
    if (!pending) {
      return false;
    }
    
    // Check if still within deduplication window
    const age = Date.now() - pending.timestamp;
    if (age > this.defaultWindowMs) {
      this.pendingRequests.delete(requestHash);
      return false;
    }
    
    return true;
  }

  /**
   * Get pending request promise
   */
  getPending(requestHash: string): Promise<Response> | null {
    const pending = this.pendingRequests.get(requestHash);
    if (!pending) {
      return null;
    }
    
    return pending.promise;
  }

  /**
   * Register a new pending request
   */
  register(requestHash: string, promise: Promise<Response>): void {
    this.pendingRequests.set(requestHash, {
      promise,
      timestamp: Date.now()
    });
    
    // Clean up after promise resolves
    promise.finally(() => {
      // Small delay before cleanup to allow duplicate requests to benefit
      setTimeout(() => {
        this.pendingRequests.delete(requestHash);
      }, 100);
    });
  }

  /**
   * Clean up expired pending requests
   */
  cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    this.pendingRequests.forEach((pending, hash) => {
      if (now - pending.timestamp > this.defaultWindowMs) {
        expired.push(hash);
      }
    });
    
    expired.forEach(hash => this.pendingRequests.delete(hash));
  }

  /**
   * Get deduplication stats
   */
  getStats() {
    return {
      pendingCount: this.pendingRequests.size,
      oldestPendingAge: this.getOldestPendingAge()
    };
  }

  private getOldestPendingAge(): number {
    let oldest = 0;
    const now = Date.now();
    
    this.pendingRequests.forEach(pending => {
      const age = now - pending.timestamp;
      if (age > oldest) {
        oldest = age;
      }
    });
    
    return oldest;
  }
}

// Singleton instance
export const deduplicator = new RequestDeduplicator();

// Clean up expired requests every 10 seconds
setInterval(() => {
  deduplicator.cleanup();
}, 10000);
