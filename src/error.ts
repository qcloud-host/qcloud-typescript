export class QCloudAIError extends Error {
  /** Stable identity for an explicit retry after a generation or draft-create error. */
  clientRequestId?: string;
  constructor(message: string) {
    super(message);
    this.name = "QCloudAIError";
  }
}

export class APIError extends QCloudAIError {
  requestID?: string;
  readonly status: number;
  readonly errorType: string | undefined;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    opts?: { errorType?: string; body?: unknown },
  ) {
    super(`[${status}] ${message}`);
    this.name = "APIError";
    this.status = status;
    this.errorType = opts?.errorType;
    this.body = opts?.body;
  }
}

export class AuthenticationError extends APIError {
  constructor(message = "Invalid API key", body?: unknown) {
    super(401, message, { errorType: "auth_error", body });
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends APIError {
  constructor(message = "Permission denied", body?: unknown) {
    super(403, message, { errorType: "auth_error", body });
    this.name = "PermissionDeniedError";
  }
}

export class NotFoundError extends APIError {
  constructor(message = "Resource not found", body?: unknown) {
    super(404, message, { errorType: "invalid_request_error", body });
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends APIError {
  constructor(message = "Rate limit exceeded", body?: unknown) {
    super(429, message, { errorType: "rate_limit_error", body });
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends APIError {
  constructor(message = "Insufficient credits", body?: unknown) {
    super(402, message, { errorType: "billing_error", body });
    this.name = "InsufficientCreditsError";
  }
}

export class InternalServerError extends APIError {
  constructor(status = 500, message = "Internal server error", body?: unknown) {
    super(status, message, { errorType: "server_error", body });
    this.name = "InternalServerError";
  }
}

export class APIConnectionError extends QCloudAIError {
  readonly cause?: Error;

  constructor(message = "Connection error", opts?: { cause?: Error }) {
    super(message);
    this.name = "APIConnectionError";
    this.cause = opts?.cause;
  }
}

export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "APITimeoutError";
  }
}

export class APIResponseValidationError extends QCloudAIError {
  constructor(message: string) {
    super(message);
    this.name = "APIResponseValidationError";
  }
}

const STATUS_MAP: Record<
  number,
  new (msg: string, body?: unknown) => APIError
> = {
  401: AuthenticationError,
  402: InsufficientCreditsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  429: RateLimitError,
};

export function raiseForStatus(
  status: number,
  body: unknown,
  requestID?: string,
): void {
  if (status >= 200 && status < 300) return;

  let message = "Unknown error";
  let errorType: string | undefined;

  if (body && typeof body === "object" && "error" in body) {
    const err = (body as Record<string, unknown>).error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.type === "string") errorType = e.type;
    }
  }

  const Cls = STATUS_MAP[status];
  const error = Cls
    ? new Cls(message, body)
    : status >= 500
      ? new InternalServerError(status, message, body)
      : new APIError(status, message, { errorType, body });
  error.requestID = requestID;
  throw error;
}
