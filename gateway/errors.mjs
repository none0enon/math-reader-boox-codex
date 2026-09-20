export class GatewayError extends Error {
  constructor(code, message, statusCode = 500, options = {}) {
    super(message, options);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof GatewayError) return reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new GatewayError('request_timeout', 'The request timed out.', 504, { cause: reason });
  }
  return new GatewayError('request_cancelled', 'The request was cancelled.', 499, {
    cause: reason instanceof Error ? reason : undefined,
  });
}

export function asGatewayError(error) {
  if (error instanceof GatewayError) return error;
  if (error?.code && Number.isInteger(error?.statusCode)) {
    return new GatewayError(error.code, error.message || 'Request failed.', error.statusCode, {
      cause: error,
    });
  }
  return new GatewayError('internal_error', 'The gateway could not complete the request.', 500, {
    cause: error instanceof Error ? error : undefined,
  });
}
