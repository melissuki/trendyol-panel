import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { env, isProd } from './config/env.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/auth.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { healthRouter } from './routes/health.js';
import { productsRouter } from './routes/products.js';
import { reportsRouter } from './routes/reports.js';

/**
 * EXPRESS UYGULAMASI (yalnizca yapilandirma - PORT DINLEMEZ)
 * =============================================================================
 * Bu dosya bilerek `listen()` CAGIRMAZ. Boylece ayni uygulama iki ortamda da
 * calisir:
 *   - Yerel/sunucu : src/index.js dosyasi bunu import edip listen() eder
 *   - Vercel       : api/[...path].js dosyasi bunu handler olarak disa aktarir
 *
 * Sunucusuz (serverless) ortamda port dinlemek HATADIR; fonksiyon her istekte
 * cagrilir, kalici bir soket yoktur.
 */

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

/**
 * SIKI CORS
 * Sadece .env icinde tanimli originlere izin verilir. Origin basligi olmayan
 * istekler (curl, sunucu-sunucu) tarayici disidir; sadece gelistirmede serbest.
 * Content-Disposition expose edilir ki frontend dosya adini okuyabilsin.
 */
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, !isProd);
    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn('CORS reddedildi', { origin });
    return callback(
      new AppError(`CORS politikası bu kaynağa izin vermiyor: ${origin}`, {
        status: 403,
        code: 'CORS_FORBIDDEN',
      }),
    );
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'X-Report-Rows'],
  credentials: false,
  maxAge: 600,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(morgan(isProd ? 'combined' : 'dev'));

// Trendyol API'sini korumak icin istemci basina kaba bir sinir
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Çok fazla istek gönderildi, lütfen biraz bekleyin.' } },
  }),
);

// --- Kimlik dogrulama: giris ve durum uc noktalari HERKESE ACIK ------------
app.use('/api', authRouter);

/**
 * AUTH GUARD
 * Bu satirdan SONRA tanimlanan tum /api/* rotalari gecerli bir JWT ister.
 * /api/health (sunucu ayakta mi) bilerek disarida tutulur: yuk dengeleyici ve
 * izleme sistemleri kimlik dogrulamadan saglik kontrolu yapabilmeli.
 * Trendyol verisi donen HICBIR uc nokta korumasiz degildir.
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.use('/api', requireAuth);

app.use('/api', diagnosticsRouter);
app.use('/api', healthRouter);
app.use('/api', productsRouter);
app.use('/api', reportsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
