// Business errors; the global error handler turns them into `{ error: { code, message } }`.
export class AppError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429;
  readonly code: string;

  constructor(status: AppError["status"], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
