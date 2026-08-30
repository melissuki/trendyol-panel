import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { loginRateLimiter, requireAuth } from '../middleware/auth.js';
import { parseQuery } from '../middleware/validate.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isAuthConfigured, issueToken, verifyCredentials } from '../services/authService.js';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Kullanıcı adı zorunludur').max(120),
  password: z.string().min(1, 'Parola zorunludur').max(200),
});

/** Giris ekraninin, kurulumun tamamlanip tamamlanmadigini bilmesi icin. */
authRouter.get('/auth/status', (req, res) => {
  res.json({ configured: isAuthConfigured() });
});

/**
 * POST /api/auth/login  { username, password } -> { token, expiresAt, user }
 * Basarisiz denemeler loglanir ve hiz sinirina takilir.
 */
authRouter.post(
  '/auth/login',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = parseQuery(loginSchema, req.body ?? {});

    const user = await verifyCredentials(username, password);
    if (!user) {
      logger.warn('failed login attempt', { ip: req.ip, username: String(username).slice(0, 64) });
      // Kullanici adi mi parola mi yanlis bilgisi KASITLI olarak verilmez.
      throw new AppError('Kullanıcı adı veya parola hatalı.', {
        status: 401,
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }

    const { token, expiresAt } = issueToken(user);
    logger.info('login ok', { username: user.username, ip: req.ip });
    res.json({ token, expiresAt, user: { username: user.username, role: 'admin' } });
  }),
);

/** Jetonun hala gecerli olup olmadigini kontrol eder (sayfa yenilemesinde). */
authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Jeton durumsuz (stateless) oldugu icin cikis istemcide jetonun silinmesidir.
 * Uc nokta, istemcinin tek bir akis izleyebilmesi ve denetim kaydi icin var.
 */
authRouter.post('/auth/logout', requireAuth, (req, res) => {
  logger.info('logout', { username: req.user?.username });
  res.json({ status: 'ok' });
});
