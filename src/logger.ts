// Structured logging utility with log level filtering

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'NONE';

export interface LogEntry {
  timestamp: string;
  method: string;
  requestUrl: string;
  path: string;
  matchedPrefix?: string;
  targetUrl?: string;
  status: number;
  responseTime: number;
  timeout?: boolean;
  error?: string;
  level?: LogLevel;
  [key: string]: any;
}

// Log level hierarchy: DEBUG < INFO < WARN < ERROR < NONE
const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

let currentLogLevel: LogLevel = 'INFO'; // Default log level

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

export function shouldLog(entryLevel: LogLevel = 'INFO'): boolean {
  return LOG_LEVELS[entryLevel] >= LOG_LEVELS[currentLogLevel];
}

export function log(entry: LogEntry): void {
  const level = entry.level || 'INFO';
  if (!shouldLog(level)) {
    return;
  }
  console.log(JSON.stringify(entry));
}

export function createLogEntry(
  request: Request,
  status: number,
  responseTime: number,
  options: {
    matchedPrefix?: string;
    targetUrl?: string;
    timeout?: boolean;
    error?: string;
    url?: URL; // Optional pre-parsed URL to avoid re-parsing
    reason?: string;
    origin?: string;
    worker?: string;
    hasToken?: boolean;
    clientIp?: string;
    limit?: number;
    current?: number;
    retryAfter?: number;
    auditType?: string;
    authenticated?: boolean;
    path?: string;
    routePrefix?: string;
    hmacRequired?: boolean;
    userAgent?: string;
    hasTimestamp?: boolean;
    hasNonce?: boolean;
    hmacVerified?: boolean;
    hmacBypassed?: boolean;
    cacheHit?: boolean;
    cacheKey?: string;
    deduplicated?: boolean;
    requestHash?: string;
    [key: string]: any; // Allow additional properties for audit logging
  } = {}
): LogEntry {
  // Use pre-parsed URL if provided, otherwise parse
  const { matchedPrefix, targetUrl, timeout, error, url: providedUrl, ...extra } = options;
  const url = providedUrl || new URL(request.url);
  
  // Determine log level based on status code
  let level: LogLevel = 'INFO';
  if (status >= 500) {
    level = 'ERROR';
  } else if (status >= 400) {
    level = 'WARN';
  }
  
  return {
    ...extra,
    timestamp: new Date().toISOString(),
    method: request.method,
    requestUrl: request.url,
    path: url.pathname + url.search,
    matchedPrefix,
    targetUrl,
    status,
    responseTime,
    timeout,
    error,
    level
  };
}
