export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = undefined } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new AppError(message, { status: 400, code: 'BAD_REQUEST', details });

export const notFound = (message, details) =>
  new AppError(message, { status: 404, code: 'NOT_FOUND', details });

export const upstream = (message, details) =>
  new AppError(message, { status: 502, code: 'TRENDYOL_UPSTREAM_ERROR', details });
