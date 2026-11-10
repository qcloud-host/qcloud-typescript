export class QCloudAIError extends Error {
  /** Stable identity for an explicit retry after a generation or draft-create error. */
  clientRequestId?: string;
  constructor(message: string) {
    super(message);
    this.name = "QCloudAIError";
  }
}

/**
 * Limits reported by QCloud admission for the failed request. Fields are
 * undefined when not reported. They describe request admission, not a
 * provider's final billing limit.
 */
export interface RateLimitInfo {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
}

function integerHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name)?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Parse `Retry-After` as delta-seconds or an HTTP date. Returns seconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function rateLimitFromHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {
    limitRequests: integerHeader(headers, "x-ratelimit-limit-requests"),
    remainingRequests: integerHeader(headers, "x-ratelimit-remaining-requests"),
    limitTokens: integerHeader(headers, "x-ratelimit-limit-tokens"),
    remainingTokens: integerHeader(headers, "x-ratelimit-remaining-tokens"),
  };
  return Object.values(info).some((value) => value !== undefined) ? info : undefined;
}

export class APIError extends QCloudAIError {
  /** QCloud request identity for logs and support. */
  requestID?: string;
  /** Response headers of the failed request, when available. */
  headers?: Headers;
  /** Parsed `Retry-After` delay in seconds. */
  retryAfter?: number;
  /** Admission limits reported with the failed request. */
  rateLimit?: RateLimitInfo;
  readonly status: number;
  readonly errorType: string | undefined;
  /** Machine-readable error code when the API returns one. */
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    opts?: { errorType?: string; code?: string; body?: unknown },
  ) {
    super(`[${status}] ${message}`);
    this.name = "APIError";
    this.status = status;
    this.errorType = opts?.errorType;
    this.code = opts?.code;
    this.body = opts?.body;
  }

  /** @internal */
  _attachHeaders(headers: Headers | undefined): this {
    if (!headers) return this;
    this.headers = headers;
    this.requestID = headers.get("x-request-id") ?? headers.get("request-id") ?? this.requestID;
    this.retryAfter = parseRetryAfter(headers.get("retry-after"));
    this.rateLimit = rateLimitFromHeaders(headers);
    return this;
  }
}

type Details = { errorType?: string; code?: string };

export class BadRequestError extends APIError {
  constructor(message = "Bad request", body?: unknown, details?: Details) {
    super(400, message, { errorType: details?.errorType ?? "invalid_request_error", code: details?.code, body });
    this.name = "BadRequestError";
  }
}

export class AuthenticationError extends APIError {
  constructor(message = "Invalid API key", body?: unknown, details?: Details) {
    super(401, message, { errorType: details?.errorType ?? "auth_error", code: details?.code, body });
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends APIError {
  constructor(message = "Permission denied", body?: unknown, details?: Details) {
    super(403, message, { errorType: details?.errorType ?? "auth_error", code: details?.code, body });
    this.name = "PermissionDeniedError";
  }
}

export class NotFoundError extends APIError {
  constructor(message = "Resource not found", body?: unknown, details?: Details) {
    super(404, message, { errorType: details?.errorType ?? "invalid_request_error", code: details?.code, body });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends APIError {
  constructor(message = "Conflict", body?: unknown, details?: Details) {
    super(409, message, { errorType: details?.errorType ?? "conflict_error", code: details?.code, body });
    this.name = "ConflictError";
  }
}

export class UnprocessableEntityError extends APIError {
  constructor(message = "Unprocessable request", body?: unknown, details?: Details) {
    super(422, message, { errorType: details?.errorType ?? "invalid_request_error", code: details?.code, body });
    this.name = "UnprocessableEntityError";
  }
}

export class RateLimitError extends APIError {
  constructor(message = "Rate limit exceeded", body?: unknown, details?: Details) {
    super(429, message, { errorType: details?.errorType ?? "rate_limit_error", code: details?.code, body });
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends APIError {
  constructor(message = "Insufficient credits", body?: unknown, details?: Details) {
    super(402, message, { errorType: details?.errorType ?? "billing_error", code: details?.code, body });
    this.name = "InsufficientCreditsError";
  }
}

export class InternalServerError extends APIError {
  constructor(status = 500, message = "Internal server error", body?: unknown, details?: Details) {
    super(status, message, { errorType: details?.errorType ?? "server_error", code: details?.code, body });
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
  new (msg: string, body?: unknown, details?: Details) => APIError
> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: InsufficientCreditsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

/** @internal Extract message, type and code from an OpenAI- or Anthropic-style error envelope. */
export function errorDetails(body: unknown): { message?: string; errorType?: string; code?: string } {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const err = (body as Record<string, unknown>).error;
  if (typeof err === "string") return { message: err };
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    errorType: typeof e.type === "string" ? e.type : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
  };
}

/**
 * Throw the typed error for a non-2xx status. The third argument may be the
 * response headers (preferred) or, for compatibility, a request ID.
 */
export function raiseForStatus(
  status: number,
  body: unknown,
  headersOrRequestID?: Headers | string,
): void {
  if (status >= 200 && status < 300) return;

  const { message = "Unknown error", errorType, code } = errorDetails(body);
  const details: Details = { errorType, code };
  const Cls = STATUS_MAP[status];
  const error = Cls
    ? new Cls(message, body, details)
    : status >= 500
      ? new InternalServerError(status, message, body, details)
      : new APIError(status, message, { errorType, code, body });
  if (typeof headersOrRequestID === "string") error.requestID = headersOrRequestID;
  else error._attachHeaders(headersOrRequestID);
  throw error;
}
