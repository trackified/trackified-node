export interface ErrorInit {
  status?: number;
  code?: string;
  requestId?: string;
  cause?: unknown;
}

export class TrackifiedError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
  }

  /** Alias matching the API's field name. */
  get request_id(): string | undefined {
    return this.requestId;
  }
}

export class AuthenticationError extends TrackifiedError {}
export class PermissionError extends TrackifiedError {}
export class NotFoundError extends TrackifiedError {}
export class ValidationError extends TrackifiedError {}
export class APIError extends TrackifiedError {}
export class ConnectionError extends TrackifiedError {}
export class SignatureVerificationError extends TrackifiedError {}

export class RateLimitError extends TrackifiedError {
  /** Seconds to wait, from the retry-after header. */
  readonly retryAfter: number | undefined;
  constructor(message: string, init: ErrorInit & { retryAfter?: number } = {}) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

export function errorFromResponse(status: number, body: unknown, headers: Headers): TrackifiedError {
  const err = (body as { error?: { code?: string; message?: string; request_id?: string } })?.error;
  const message = err?.message ?? `HTTP ${status}`;
  const init: ErrorInit = {
    status,
    code: err?.code,
    requestId: err?.request_id ?? headers.get("x-request-id") ?? undefined,
  };
  if (status === 401) return new AuthenticationError(message, init);
  if (status === 403) return new PermissionError(message, init);
  if (status === 404) return new NotFoundError(message, init);
  if (status === 400 || status === 422) return new ValidationError(message, init);
  if (status === 429) {
    return new RateLimitError(message, { ...init, retryAfter: parseRetryAfter(headers) });
  }
  if (status >= 500) return new APIError(message, init);
  return new TrackifiedError(message, init);
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}
