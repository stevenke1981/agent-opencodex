export class AocxError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code ?? "aocx_error";
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ConfigError extends AocxError {
  constructor(message, details) {
    super(message, { code: "config_error", status: 400, details });
  }
}

export class RequestError extends AocxError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code ?? "invalid_request_error",
      status: options.status ?? 400,
      details: options.details,
    });
  }
}

export class UpstreamError extends AocxError {
  constructor(message, options = {}) {
    super(message, {
      code: options.code ?? "upstream_error",
      status: options.status ?? 502,
      retryable: options.retryable ?? false,
      details: options.details,
      cause: options.cause,
    });
    this.provider = options.provider;
    this.upstreamStatus = options.upstreamStatus;
  }
}

export class AcceptanceError extends AocxError {
  constructor(message, details) {
    super(message, { code: "acceptance_error", status: 400, details });
  }
}

export function toPublicError(error, requestId) {
  const safe = error instanceof AocxError ? error : new AocxError("Internal gateway error");
  return {
    error: {
      message: safe.message,
      type: safe.code,
      code: safe.code,
      request_id: requestId,
      retryable: Boolean(safe.retryable),
      ...(safe.details === undefined ? {} : { details: safe.details }),
    },
  };
}
