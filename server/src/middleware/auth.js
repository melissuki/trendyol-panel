import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { verifyToken } from '../services/authService.js';

/**
 * AUTH GUARD
 * Korunan tum /api/* uc noktalarinda "Authorization: Bearer <jwt>" bekler.
 * Jeton yoksa/gecersizse istek Trendyol'a HIC ulasmadan 401 ile reddedilir.
 */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(/\s+/);

  if (!token || !/^bearer$/i.test(scheme)) {
    return next(
      new AppError('Bu işlem için giriş yapmanız gerekiyor.', {
        status: 401,
        code: 'AUTH_REQUIRED',
      }),
    );
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Giris denemelerine siki sinir: kaba kuvvet saldirisini yavaslatir.
 * Anahtar = IP + denenen kullanici adi; basarili girisler sayilmaz.
 */
export const loginRateLimiter = rateLimit({
  windowMs: env.AUTH_WINDOW_MINUTES * 60 * 1000,
  limit: env.AUTH_MAX_ATTEMPTS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}::${String(req.body?.username ?? '').slice(0, 64)}`,
  handler: (req, res) => {
    logger.warn('login rate limited', { ip: req.ip });
    res.status(429).json({
      error: {
        code: 'AUTH_RATE_LIMITED',
        message: `Çok fazla başarısız giriş denemesi. ${env.AUTH_WINDOW_MINUTES} dakika sonra tekrar deneyin.`,
      },
    });
  },
});
