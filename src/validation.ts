// Request validation

export interface SizeLimits {
  maxBodySize?: number; // Max request body size in bytes
  maxUrlLength?: number; // Max URL length in characters
  maxHeaderSize?: number; // Max total header size in bytes
  maxHeaderCount?: number; // Max number of headers
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  statusCode?: number;
}

export function validateRequestSize(
  request: Request,
  limits: SizeLimits
): ValidationResult {
  // Check URL length
  if (limits.maxUrlLength && request.url.length > limits.maxUrlLength) {
    return {
      valid: false,
      error: `URL length exceeds limit of ${limits.maxUrlLength} characters`,
      statusCode: 414 // URI Too Long
    };
  }

  // Check Content-Length header for body size
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && limits.maxBodySize) {
    const bodySize = parseInt(contentLength, 10);
    if (!isNaN(bodySize) && bodySize > limits.maxBodySize) {
      return {
        valid: false,
        error: `Request body size ${bodySize} bytes exceeds limit of ${limits.maxBodySize} bytes`,
        statusCode: 413 // Payload Too Large
      };
    }
  }

  // Check header size and count
  let totalHeaderSize = 0;
  let headerCount = 0;
  
  request.headers.forEach((value, key) => {
    headerCount++;
    totalHeaderSize += key.length + value.length + 4; // +4 for ': ' and '\r\n'
  });

  if (limits.maxHeaderCount && headerCount > limits.maxHeaderCount) {
    return {
      valid: false,
      error: `Header count ${headerCount} exceeds limit of ${limits.maxHeaderCount}`,
      statusCode: 431 // Request Header Fields Too Large
    };
  }

  if (limits.maxHeaderSize && totalHeaderSize > limits.maxHeaderSize) {
    return {
      valid: false,
      error: `Total header size ${totalHeaderSize} bytes exceeds limit of ${limits.maxHeaderSize} bytes`,
      statusCode: 431 // Request Header Fields Too Large
    };
  }

  return { valid: true };
}

export const DEFAULT_LIMITS: SizeLimits = {
  maxBodySize: 10 * 1024 * 1024, // 10 MB
  maxUrlLength: 8192, // 8 KB
  maxHeaderSize: 16384, // 16 KB
  maxHeaderCount: 100
};
