// Business errors; the global error handler turns them into `{ error: { code, message } }`.
export class AppError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 502 | 503;
  readonly code: string;
  // Seconds, sent as Retry-After with 429.
  readonly retryAfter: number | undefined;

  constructor(
    status: AppError["status"],
    code: string,
    message: string,
    options: { cause?: unknown; retryAfter?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
  }
}
