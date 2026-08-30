import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { cacheClear } from '../lib/cache.js';
import { env } from '../config/env.js';
import { pingTrendyol } from '../services/trendyolClient.js';

export const healthRouter = Router();

healthRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timeZone: env.REPORT_TIMEZONE,
    // Komisyon/kargo tutarlari HER ZAMAN mutabakat API'sinden okunur (tahmin yok)
    financeSource: 'settlement',
  });
});

/** Trendyol kimlik bilgilerinin gerçekten çalıştığını doğrular. */
healthRouter.get(
  '/health/trendyol',
  asyncHandler(async (req, res) => {
    await pingTrendyol();
    res.json({ status: 'ok', message: 'Trendyol API bağlantısı başarılı.' });
  }),
);

healthRouter.post('/cache/clear', (req, res) => {
  const cleared = cacheClear();
  res.json({ status: 'ok', message: `${cleared} önbellek kaydı temizlendi.` });
});
