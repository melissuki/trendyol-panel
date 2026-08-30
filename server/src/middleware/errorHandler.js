import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Uç nokta bulunamadı: ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, next) {
  const status = error instanceof AppError ? error.status : error.status ?? 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';

  if (status >= 500) {
    logger.error('request failed', { path: req.originalUrl, message: error.message, stack: error.stack });
  } else {
    logger.warn('request rejected', { path: req.originalUrl, status, message: error.message });
  }

  if (res.headersSent) {
    // Excel akışı başladıysa gövdeyi bozmadan bağlantıyı kapat
    return res.end();
  }

  res.status(status).json({
    error: {
      code,
      message: status >= 500 && isProd ? 'Sunucuda beklenmeyen bir hata oluştu.' : error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

/** async route handler'larda try/catch tekrarını önler */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
