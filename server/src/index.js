import http from 'node:http';

import app from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

/**
 * YEREL / KENDI SUNUCUNDA CALISTIRMA GIRIS NOKTASI
 * Vercel gibi sunucusuz ortamlarda bu dosya KULLANILMAZ; oradaki giris
 * noktasi kokteki `api/[...path].js` dosyasidir ve `app.js`i disa aktarir.
 */

const server = http.createServer(app);
// Excel uretimi uzun surebilir; varsayilan 2dk soket zaman asimini yukseltiyoruz
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 5000;

server.listen(env.PORT, () => {
  logger.info('server started', {
    port: env.PORT,
    env: env.NODE_ENV,
    corsOrigins: env.CORS_ORIGINS,
    sellerId: String(env.TRENDYOL_SELLER_ID).replace(/.(?=.{2})/g, '*'),
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { reason: String(reason) }));
